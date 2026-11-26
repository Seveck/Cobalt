use std::sync::Arc;

use arrow_array::{
    Array, FixedSizeListArray, Float32Array, RecordBatch, RecordBatchIterator, StringArray,
};
use arrow_schema::{DataType, Field, Schema, SchemaRef};
use async_trait::async_trait;
use cobalt_core::enums::EngineKind;
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::ids::{Id, id_from_str};
use cobalt_core::search::{VectorHit, VectorRecord};
use futures_util::TryStreamExt;
use lancedb::query::{ExecutableQuery, QueryBase, Select};

use super::{Backend, engine_error};

pub(super) struct Lance {
    db: lancedb::Connection,
    table: lancedb::Table,
    name: String,
    schema: SchemaRef,
}

impl Lance {
    pub(super) async fn open(path: &str, name: &str, dimensions: usize) -> Result<Self> {
        if path.trim().is_empty() || path.contains("://") {
            return Err(CobaltError::InvalidInput(
                "LanceDB requires a local directory path".into(),
            ));
        }
        let path = std::path::absolute(path)?;
        let path = path
            .to_str()
            .ok_or_else(|| CobaltError::InvalidInput("LanceDB path must be Unicode".into()))?;
        let db = lancedb::connect(path)
            .execute()
            .await
            .map_err(engine_error)?;
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Utf8, false),
            Field::new("record_metadata", DataType::Utf8, false),
            Field::new(
                "vector",
                DataType::FixedSizeList(
                    Arc::new(Field::new("item", DataType::Float32, true)),
                    dimensions as i32,
                ),
                false,
            ),
        ]));
        Self::connect(db, name, schema).await
    }

    async fn connect(db: lancedb::Connection, name: &str, schema: SchemaRef) -> Result<Self> {
        let table = match db.open_table(name).execute().await {
            Ok(table) => table,
            Err(lancedb::Error::TableNotFound { .. }) => db
                .create_empty_table(name, schema.clone())
                .execute()
                .await
                .map_err(engine_error)?,
            Err(error) => return Err(engine_error(error)),
        };
        let this = Self {
            db,
            table,
            name: name.to_owned(),
            schema,
        };
        this.health().await?;
        Ok(this)
    }

    fn id_predicate(ids: &[Id]) -> String {
        let values = ids
            .iter()
            .map(|id| format!("'{id}'"))
            .collect::<Vec<_>>()
            .join(",");
        format!("id IN ({values})")
    }
}

fn column<'a, T: Array + 'static>(batch: &'a RecordBatch, name: &str) -> Result<&'a T> {
    batch
        .column_by_name(name)
        .and_then(|column| column.as_any().downcast_ref())
        .ok_or_else(|| engine_error(format!("unexpected LanceDB {name} column")))
}

#[async_trait]
impl Backend for Lance {
    fn kind(&self) -> EngineKind {
        EngineKind::LanceDb
    }
    fn name(&self) -> &str {
        &self.name
    }

    async fn fork(&self, name: &str) -> Result<Arc<dyn Backend>> {
        Ok(Arc::new(
            Self::connect(self.db.clone(), name, self.schema.clone()).await?,
        ))
    }
    async fn destroy(&self) -> Result<()> {
        self.db
            .drop_table(&self.name, &[])
            .await
            .map_err(engine_error)
    }

    async fn put(&self, records: &[VectorRecord]) -> Result<()> {
        let ids =
            StringArray::from_iter_values(records.iter().map(|row| row.memory_id.to_string()));
        let metadata = records
            .iter()
            .map(|row| {
                serde_json::to_string(&(row.project_id, row.branch_id, row.is_reusable, row.status))
            })
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let array = Float32Array::from_iter_values(
            records.iter().flat_map(|row| row.vector.iter().copied()),
        );
        let DataType::FixedSizeList(field, dims) = self.schema.field(2).data_type() else {
            return Err(engine_error("LanceDB vector schema missing"));
        };
        let vectors = FixedSizeListArray::try_new(field.clone(), *dims, Arc::new(array), None)
            .map_err(engine_error)?;
        let batch = RecordBatch::try_new(
            self.schema.clone(),
            vec![
                Arc::new(ids),
                Arc::new(StringArray::from(metadata)),
                Arc::new(vectors),
            ],
        )
        .map_err(engine_error)?;
        let reader = RecordBatchIterator::new([Ok(batch)], self.schema.clone());
        let mut merge = self.table.merge_insert(&["id"]);
        merge
            .when_matched_update_all(None)
            .when_not_matched_insert_all();
        merge
            .execute(Box::new(reader))
            .await
            .map_err(engine_error)?;
        Ok(())
    }

    async fn delete(&self, ids: &[Id]) -> Result<()> {
        self.table
            .delete(Self::id_predicate(ids).as_str())
            .await
            .map_err(engine_error)?;
        Ok(())
    }

    async fn get(&self, ids: &[Id]) -> Result<Vec<VectorRecord>> {
        let mut batches = self
            .table
            .query()
            .only_if(Self::id_predicate(ids))
            .execute()
            .await
            .map_err(engine_error)?;
        let mut output = Vec::new();
        while let Some(batch) = batches.try_next().await.map_err(engine_error)? {
            let ids = column::<StringArray>(&batch, "id")?;
            let vectors = column::<FixedSizeListArray>(&batch, "vector")?;
            let metadata = column::<StringArray>(&batch, "record_metadata")?;
            for i in 0..batch.num_rows() {
                let (project_id, branch_id, is_reusable, status) =
                    serde_json::from_str(metadata.value(i))?;
                let vector = vectors.value(i);
                let vector = vector
                    .as_any()
                    .downcast_ref::<Float32Array>()
                    .ok_or_else(|| engine_error("unexpected LanceDB vector values"))?;
                output.push(VectorRecord {
                    memory_id: id_from_str(ids.value(i))?,
                    vector: vector.values().to_vec(),
                    project_id,
                    branch_id,
                    is_reusable,
                    status,
                });
            }
        }
        Ok(output)
    }

    async fn nearest(&self, query: &[f32], limit: usize) -> Result<Vec<VectorHit>> {
        let mut batches = self
            .table
            .query()
            .limit(limit)
            .select(Select::columns(&["id"]))
            .nearest_to(query)
            .map_err(engine_error)?
            .column("vector")
            .distance_type(lancedb::DistanceType::Cosine)
            .bypass_vector_index()
            .execute()
            .await
            .map_err(engine_error)?;
        let mut hits = Vec::new();
        while let Some(batch) = batches.try_next().await.map_err(engine_error)? {
            let ids = column::<StringArray>(&batch, "id")?;
            let distance = column::<Float32Array>(&batch, "_distance")?;
            for i in 0..batch.num_rows() {
                hits.push(VectorHit {
                    memory_id: id_from_str(ids.value(i))?,
                    similarity: (1.0 - distance.value(i)).clamp(0.0, 1.0),
                });
            }
        }
        Ok(hits)
    }

    async fn count(&self) -> Result<u64> {
        Ok(self.table.count_rows(None).await.map_err(engine_error)? as u64)
    }

    async fn health(&self) -> Result<()> {
        if self.table.schema().await.map_err(engine_error)?.fields() != self.schema.fields() {
            return Err(engine_error(
                "LanceDB table schema or embedding dimensions differ",
            ));
        }
        Ok(())
    }
}
