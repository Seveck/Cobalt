use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use cobalt_core::enums::{EngineKind, MemoryStatus};
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::ids::Id;
use cobalt_core::search::{VectorHit, VectorRecord};
use reqwest::{Method, StatusCode, Url};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

use super::{Backend, engine_error};

#[async_trait]
trait Transport: Send + Sync {
    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Option<Value>>;
}

struct Http {
    client: reqwest::Client,
    url: Url,
    key: Option<(&'static str, reqwest::header::HeaderValue)>,
}

impl Http {
    fn new(endpoint: &str, api_key: Option<&str>, header: &'static str) -> Result<Self> {
        let url = Url::parse(endpoint)
            .map_err(|_| CobaltError::InvalidInput("invalid vector endpoint URL".into()))?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(CobaltError::InvalidInput(
                "vector endpoint must be an HTTP(S) base URL".into(),
            ));
        }
        let key = api_key
            .map(|key| {
                let mut key = reqwest::header::HeaderValue::from_str(key).map_err(|_| {
                    CobaltError::InvalidInput("invalid vector API key header".into())
                })?;
                key.set_sensitive(true);
                Ok::<_, CobaltError>((header, key))
            })
            .transpose()?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(engine_error)?;
        Ok(Self { client, url, key })
    }
}

#[async_trait]
impl Transport for Http {
    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Option<Value>> {
        let url = format!("{}{}", self.url.as_str().trim_end_matches('/'), path);
        let mut req = self.client.request(method.clone(), url);
        if let Some((name, value)) = &self.key {
            req = req.header(*name, value);
        }
        if let Some(body) = body {
            req = req.json(&body);
        }
        let response = req
            .send()
            .await
            .map_err(|error| engine_error(error.without_url()))?;
        let status = response.status();
        if status == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !status.is_success() {
            return Err(engine_error(format!(
                "{method} vector endpoint returned HTTP {status}"
            )));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|error| engine_error(error.without_url()))?;
        if bytes.is_empty() {
            return Ok(Some(Value::Null));
        }
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(engine_error)
    }
}

async fn required(
    http: &dyn Transport,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value> {
    http.request(method, path, body)
        .await?
        .ok_or_else(|| engine_error("vector collection not found"))
}

fn decode<T: DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(engine_error)
}

#[derive(Serialize, Deserialize)]
struct Metadata {
    // Chroma metadata values must be scalars.
    project_id: String,
    branch_id: Id,
    is_reusable: bool,
    status: MemoryStatus,
}

impl Metadata {
    fn from_record(record: &VectorRecord) -> Self {
        Self {
            project_id: record
                .project_id
                .map(|id| id.to_string())
                .unwrap_or_default(),
            branch_id: record.branch_id,
            is_reusable: record.is_reusable,
            status: record.status,
        }
    }

    fn record(self, memory_id: Id, vector: Vec<f32>) -> Result<VectorRecord> {
        let project_id = if self.project_id.is_empty() {
            None
        } else {
            Some(cobalt_core::ids::id_from_str(&self.project_id)?)
        };
        Ok(VectorRecord {
            memory_id,
            vector,
            project_id,
            branch_id: self.branch_id,
            is_reusable: self.is_reusable,
            status: self.status,
        })
    }
}

#[cfg(feature = "qdrant")]
pub(super) struct Qdrant {
    http: Arc<dyn Transport>,
    name: String,
    dims: usize,
    kind: EngineKind,
}

#[cfg(feature = "qdrant")]
impl Qdrant {
    pub(super) async fn open(
        endpoint: &str,
        name: &str,
        dims: usize,
        api_key: Option<&str>,
        kind: EngineKind,
    ) -> Result<Self> {
        Self::connect(
            Arc::new(Http::new(endpoint, api_key, "api-key")?),
            name,
            dims,
            kind,
        )
        .await
    }

    async fn connect(
        http: Arc<dyn Transport>,
        name: &str,
        dims: usize,
        kind: EngineKind,
    ) -> Result<Self> {
        let this = Self {
            http,
            name: name.to_owned(),
            dims,
            kind,
        };
        let path = this.path("");
        if let Some(response) = this.http.request(Method::GET, &path, None).await? {
            this.verify(response)?;
        } else {
            this.call(
                Method::PUT,
                "",
                Some(json!({"vectors":{"size":dims,"distance":"Cosine"}})),
            )
            .await?;
        }
        Ok(this)
    }

    fn verify(&self, response: Value) -> Result<()> {
        let vectors = &response["result"]["config"]["params"]["vectors"];
        if vectors["size"].as_u64() != Some(self.dims as u64) || vectors["distance"] != "Cosine" {
            return Err(engine_error(
                "Qdrant collection must use the configured dimensions and cosine distance",
            ));
        }
        Ok(())
    }

    fn path(&self, tail: &str) -> String {
        format!("/collections/{}{tail}", self.name)
    }

    async fn call(&self, method: Method, tail: &str, body: Option<Value>) -> Result<Value> {
        required(self.http.as_ref(), method, &self.path(tail), body).await
    }
}

#[cfg(feature = "qdrant")]
#[async_trait]
impl Backend for Qdrant {
    fn kind(&self) -> EngineKind {
        self.kind
    }
    fn name(&self) -> &str {
        &self.name
    }

    async fn fork(&self, name: &str) -> Result<Arc<dyn Backend>> {
        Ok(Arc::new(
            Self::connect(self.http.clone(), name, self.dims, self.kind).await?,
        ))
    }
    async fn destroy(&self) -> Result<()> {
        self.call(Method::DELETE, "", None).await.map(|_| ())
    }

    async fn put(&self, records: &[VectorRecord]) -> Result<()> {
        let points: Vec<_> = records.iter().map(|record| json!({
            "id":record.memory_id,"vector":record.vector,"payload":Metadata::from_record(record)
        })).collect();
        self.call(
            Method::PUT,
            "/points?wait=true",
            Some(json!({"points": points})),
        )
        .await?;
        Ok(())
    }

    async fn delete(&self, ids: &[Id]) -> Result<()> {
        self.call(
            Method::POST,
            "/points/delete?wait=true",
            Some(json!({"points":ids})),
        )
        .await?;
        Ok(())
    }

    async fn get(&self, ids: &[Id]) -> Result<Vec<VectorRecord>> {
        #[derive(Deserialize)]
        struct Point {
            id: Id,
            vector: Vec<f32>,
            payload: Metadata,
        }
        let response = self
            .call(
                Method::POST,
                "/points",
                Some(json!({
                    "ids":ids,"with_vector":true,"with_payload":true
                })),
            )
            .await?;
        decode::<Vec<Point>>(response["result"].clone())?
            .into_iter()
            .map(|point| point.payload.record(point.id, point.vector))
            .collect()
    }

    async fn nearest(&self, query: &[f32], limit: usize) -> Result<Vec<VectorHit>> {
        #[derive(Deserialize)]
        struct Point {
            id: Id,
            score: f32,
        }
        let response = self
            .call(
                Method::POST,
                "/points/query",
                Some(json!({
                    "query":query,"limit":limit,"with_payload":false,"with_vector":false,
                    "params":{"exact":true}
                })),
            )
            .await?;
        Ok(decode::<Vec<Point>>(response["result"]["points"].clone())?
            .into_iter()
            .map(|point| VectorHit {
                memory_id: point.id,
                similarity: point.score.clamp(0.0, 1.0),
            })
            .collect())
    }

    async fn count(&self) -> Result<u64> {
        let response = self
            .call(Method::POST, "/points/count", Some(json!({"exact":true})))
            .await?;
        decode(response["result"]["count"].clone())
    }

    async fn health(&self) -> Result<()> {
        self.verify(self.call(Method::GET, "", None).await?)
    }
}

#[cfg(feature = "chroma")]
const CHROMA_COLLECTIONS: &str =
    "/api/v2/tenants/default_tenant/databases/default_database/collections";

#[cfg(feature = "chroma")]
pub(super) struct Chroma {
    http: Arc<dyn Transport>,
    name: String,
    id: Id,
    dims: usize,
}

#[cfg(feature = "chroma")]
impl Chroma {
    pub(super) async fn open(
        endpoint: &str,
        name: &str,
        dims: usize,
        api_key: Option<&str>,
    ) -> Result<Self> {
        Self::connect(
            Arc::new(Http::new(endpoint, api_key, "x-chroma-token")?),
            name,
            dims,
        )
        .await
    }

    async fn connect(http: Arc<dyn Transport>, name: &str, dims: usize) -> Result<Self> {
        let url = format!("{CHROMA_COLLECTIONS}/{name}");
        let response = if let Some(response) = http.request(Method::GET, &url, None).await? {
            response
        } else {
            required(
                http.as_ref(),
                Method::POST,
                CHROMA_COLLECTIONS,
                Some(json!({
                    "name":name,"get_or_create":true,
                    "configuration":{"hnsw":{"space":"cosine"}},
                    "metadata":{"cobalt_dimensions":dims,"hnsw:space":"cosine"}
                })),
            )
            .await?
        };
        Self::verify(&response, dims)?;
        Ok(Self {
            http,
            name: name.to_owned(),
            id: decode(response["id"].clone())?,
            dims,
        })
    }

    fn verify(response: &Value, dims: usize) -> Result<()> {
        let metadata = &response["metadata"];
        let dimension = response["dimension"]
            .as_u64()
            .or_else(|| metadata["cobalt_dimensions"].as_u64());
        let configuration = &response["configuration_json"];
        let distance = configuration["hnsw"]["space"]
            .as_str()
            .or_else(|| configuration["hnsw_configuration"]["space"].as_str())
            .or_else(|| metadata["hnsw:space"].as_str());
        if dimension != Some(dims as u64) || distance != Some("cosine") {
            return Err(engine_error(
                "Chroma collection must use the configured dimensions and cosine distance",
            ));
        }
        Ok(())
    }

    async fn call(&self, method: Method, tail: &str, body: Option<Value>) -> Result<Value> {
        required(
            self.http.as_ref(),
            method,
            &format!("{CHROMA_COLLECTIONS}/{}{tail}", self.id),
            body,
        )
        .await
    }
}

#[cfg(feature = "chroma")]
#[async_trait]
impl Backend for Chroma {
    fn kind(&self) -> EngineKind {
        EngineKind::ChromaDb
    }
    fn name(&self) -> &str {
        &self.name
    }
    async fn fork(&self, name: &str) -> Result<Arc<dyn Backend>> {
        Ok(Arc::new(
            Self::connect(self.http.clone(), name, self.dims).await?,
        ))
    }
    async fn destroy(&self) -> Result<()> {
        required(
            self.http.as_ref(),
            Method::DELETE,
            &format!("{CHROMA_COLLECTIONS}/{}", self.name),
            None,
        )
        .await
        .map(|_| ())
    }
    async fn put(&self, records: &[VectorRecord]) -> Result<()> {
        let ids: Vec<_> = records.iter().map(|record| record.memory_id).collect();
        let embeddings: Vec<_> = records.iter().map(|record| &record.vector).collect();
        let metadatas: Vec<_> = records.iter().map(Metadata::from_record).collect();
        self.call(
            Method::POST,
            "/upsert",
            Some(json!({"ids":ids,"embeddings":embeddings,"metadatas":metadatas})),
        )
        .await?;
        Ok(())
    }
    async fn delete(&self, ids: &[Id]) -> Result<()> {
        self.call(Method::POST, "/delete", Some(json!({"ids":ids})))
            .await?;
        Ok(())
    }
    async fn get(&self, ids: &[Id]) -> Result<Vec<VectorRecord>> {
        #[derive(Deserialize)]
        struct Records {
            ids: Vec<Id>,
            embeddings: Vec<Vec<f32>>,
            metadatas: Vec<Metadata>,
        }
        let rows: Records = decode(
            self.call(
                Method::POST,
                "/get",
                Some(json!({
                    "ids":ids,"include":["embeddings","metadatas"]
                })),
            )
            .await?,
        )?;
        if rows.ids.len() != rows.embeddings.len() || rows.ids.len() != rows.metadatas.len() {
            return Err(engine_error("Chroma get response has mismatched columns"));
        }
        rows.ids
            .into_iter()
            .zip(rows.embeddings)
            .zip(rows.metadatas)
            .map(|((id, vector), meta)| meta.record(id, vector))
            .collect()
    }
    async fn nearest(&self, query: &[f32], limit: usize) -> Result<Vec<VectorHit>> {
        #[derive(Deserialize)]
        struct Hits {
            ids: [Vec<Id>; 1],
            distances: [Vec<f32>; 1],
        }
        let Hits {
            ids: [ids],
            distances: [distances],
        } = decode(
            self.call(
                Method::POST,
                "/query",
                Some(json!({
                    "query_embeddings":[query],"n_results":limit,"include":["distances"]
                })),
            )
            .await?,
        )?;
        if ids.len() != distances.len() {
            return Err(engine_error("Chroma query response has mismatched columns"));
        }
        Ok(ids
            .into_iter()
            .zip(distances)
            .map(|(memory_id, distance)| VectorHit {
                memory_id,
                similarity: (1.0 - distance).clamp(0.0, 1.0),
            })
            .collect())
    }
    async fn count(&self) -> Result<u64> {
        decode(self.call(Method::GET, "/count", None).await?)
    }
    async fn health(&self) -> Result<()> {
        let path = format!("{CHROMA_COLLECTIONS}/{}", self.name);
        Self::verify(
            &required(self.http.as_ref(), Method::GET, &path, None).await?,
            self.dims,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::external::ExternalVectorStore;
    use cobalt_core::ids::{MAIN_BRANCH_ID, new_id};
    use cobalt_core::search::{ProjectScope, VectorFilter};
    use cobalt_core::traits::VectorStore;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    struct Reply {
        method: Method,
        path: String,
        body: Option<Value>,
        response: Option<Value>,
    }

    struct RestTransportMock(Mutex<VecDeque<Reply>>);

    impl RestTransportMock {
        fn new() -> Arc<Self> {
            Arc::new(Self(Mutex::default()))
        }

        fn reply(&self, method: Method, path: &str, body: Option<Value>, response: Option<Value>) {
            self.0.lock().unwrap().push_back(Reply {
                method,
                path: path.into(),
                body,
                response,
            });
        }

        fn assert_complete(&self) {
            assert!(self.0.lock().unwrap().is_empty());
        }
    }

    #[async_trait]
    impl Transport for RestTransportMock {
        async fn request(
            &self,
            method: Method,
            path: &str,
            body: Option<Value>,
        ) -> Result<Option<Value>> {
            let reply = self
                .0
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected HTTP request");
            assert_eq!(
                (method, path, body),
                (reply.method, reply.path.as_str(), reply.body)
            );
            Ok(reply.response)
        }
    }

    fn record(project_id: Option<Id>) -> VectorRecord {
        VectorRecord {
            memory_id: new_id(),
            vector: vec![1.0, 0.0],
            project_id,
            branch_id: MAIN_BRANCH_ID,
            is_reusable: true,
            status: MemoryStatus::Active,
        }
    }

    #[cfg(feature = "qdrant")]
    #[tokio::test]
    async fn qdrant_rest_create_upsert_filtered_query_count_delete_and_health() {
        let http = RestTransportMock::new();
        let collection = "/collections/cobalt-test";
        let id = new_id();
        let row = record(Some(id));
        let excluded = record(None);
        let payload = json!(Metadata::from_record(&row));
        let excluded_payload = json!(Metadata::from_record(&excluded));
        let qdrant_reply = |result: Value| Some(json!({"result": result, "status":"ok"}));
        http.reply(Method::GET, collection, None, None);
        http.reply(
            Method::PUT,
            collection,
            Some(json!({"vectors":{"size":2,"distance":"Cosine"}})),
            qdrant_reply(json!(true)),
        );
        let adapter = ExternalVectorStore::new(
            Arc::new(
                Qdrant::connect(http.clone(), "cobalt-test", 2, EngineKind::QdrantSidecar)
                    .await
                    .unwrap(),
            ),
            2,
        );
        http.reply(
            Method::PUT,
            &format!("{collection}/points?wait=true"),
            Some(json!({"points":[
                {"id":row.memory_id,"vector":row.vector,"payload":payload},
                {"id":excluded.memory_id,"vector":excluded.vector,"payload":excluded_payload}
            ]})),
            qdrant_reply(json!({"status":"completed"})),
        );
        adapter
            .upsert(&[row.clone(), excluded.clone()])
            .await
            .unwrap();
        http.reply(
            Method::POST,
            &format!("{collection}/points/count"),
            Some(json!({"exact":true})),
            qdrant_reply(json!({"count":2})),
        );
        http.reply(Method::POST, &format!("{collection}/points/query"),
            Some(json!({"query":[1.0,0.0],"limit":2,"with_payload":false,"with_vector":false,"params":{"exact":true}})),
            qdrant_reply(json!({"points":[{"id":excluded.memory_id,"score":1.0},{"id":row.memory_id,"score":0.8}]})));
        http.reply(Method::POST, &format!("{collection}/points"),
            Some(json!({"ids":[excluded.memory_id,row.memory_id],"with_vector":true,"with_payload":true})),
            qdrant_reply(json!([
                {"id":row.memory_id,"vector":row.vector,"payload":payload},
                {"id":excluded.memory_id,"vector":excluded.vector,"payload":excluded_payload}
            ])));
        let hits = adapter
            .search(
                &[1.0, 0.0],
                1,
                &VectorFilter {
                    scope: ProjectScope::Project(id),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(
            hits,
            vec![VectorHit {
                memory_id: row.memory_id,
                similarity: 0.8
            }]
        );
        http.reply(
            Method::POST,
            &format!("{collection}/points/delete?wait=true"),
            Some(json!({"points":[row.memory_id]})),
            qdrant_reply(json!({"status":"completed"})),
        );
        adapter.delete(&[row.memory_id]).await.unwrap();
        http.reply(
            Method::GET,
            collection,
            None,
            qdrant_reply(json!({"config":{"params":{"vectors":{"size":2,"distance":"Cosine"}}}})),
        );
        adapter.flush().await.unwrap();
        http.assert_complete();
        let key = Http::new("http://127.0.0.1:6333", Some("test-key"), "api-key")
            .unwrap()
            .key
            .unwrap();
        assert_eq!(key.0, "api-key");
        assert!(key.1.is_sensitive());
    }

    #[cfg(feature = "qdrant")]
    #[tokio::test]
    async fn qdrant_rest_compensates_when_the_canonical_commit_fails() {
        let http = RestTransportMock::new();
        let row = record(None);
        let points = "/collections/cobalt-test/points";
        let payload = json!(Metadata::from_record(&row));
        http.reply(
            Method::GET,
            "/collections/cobalt-test",
            None,
            Some(
                json!({"result":{"config":{"params":{"vectors":{"size":2,"distance":"Cosine"}}}}}),
            ),
        );
        let adapter = ExternalVectorStore::new(
            Arc::new(
                Qdrant::connect(http.clone(), "cobalt-test", 2, EngineKind::QdrantSidecar)
                    .await
                    .unwrap(),
            ),
            2,
        );
        let transaction = adapter.begin();
        let changed = VectorRecord {
            vector: vec![0.0, 1.0],
            ..row.clone()
        };
        transaction
            .upsert(std::slice::from_ref(&changed))
            .await
            .unwrap();
        http.assert_complete();
        http.reply(
            Method::POST,
            points,
            Some(json!({"ids":[row.memory_id],"with_vector":true,"with_payload":true})),
            Some(json!({"result":[{"id":row.memory_id,"vector":row.vector,"payload":payload}]})),
        );
        let put = format!("{points}?wait=true");
        for vector in [changed.vector, row.vector] {
            http.reply(
                Method::PUT,
                &put,
                Some(json!({"points":[
                    {"id":row.memory_id,"vector":vector,"payload":payload}
                ]})),
                Some(json!({"result":{"status":"completed"}})),
            );
        }
        let result = tokio::task::spawn_blocking(move || {
            transaction.commit::<()>(|| Err(CobaltError::Storage("canonical write failed".into())))
        })
        .await
        .unwrap();
        assert!(matches!(result, Err(CobaltError::Storage(_))));
        http.assert_complete();
    }

    #[cfg(feature = "chroma")]
    #[tokio::test]
    async fn chroma_v2_rest_count_upsert_query_get_delete_and_health() {
        let http = RestTransportMock::new();
        let row = record(None);
        let collection_id = new_id();
        let collection = format!("{CHROMA_COLLECTIONS}/{collection_id}");
        let name_path = format!("{CHROMA_COLLECTIONS}/cobalt-test");
        let metadata = json!(Metadata::from_record(&row));
        let details = json!({"id":collection_id,"dimension":2,"configuration_json":{"hnsw":{"space":"cosine"}}});
        http.reply(Method::GET, &name_path, None, None);
        http.reply(Method::POST, CHROMA_COLLECTIONS, Some(json!({
            "name":"cobalt-test","get_or_create":true,"configuration":{"hnsw":{"space":"cosine"}},
            "metadata":{"cobalt_dimensions":2,"hnsw:space":"cosine"}
        })), Some(details.clone()));
        let adapter = ExternalVectorStore::new(
            Arc::new(
                Chroma::connect(http.clone(), "cobalt-test", 2)
                    .await
                    .unwrap(),
            ),
            2,
        );
        http.reply(
            Method::POST,
            &format!("{collection}/upsert"),
            Some(json!({"ids":[row.memory_id],"embeddings":[row.vector],"metadatas":[metadata]})),
            Some(Value::Null),
        );
        adapter.upsert(std::slice::from_ref(&row)).await.unwrap();
        http.reply(
            Method::GET,
            &format!("{collection}/count"),
            None,
            Some(json!(1)),
        );
        http.reply(
            Method::POST,
            &format!("{collection}/query"),
            Some(json!({"query_embeddings":[[1.0,0.0]],"n_results":1,"include":["distances"]})),
            Some(json!({"ids":[[row.memory_id]],"distances":[[0.25]]})),
        );
        http.reply(
            Method::POST,
            &format!("{collection}/get"),
            Some(json!({"ids":[row.memory_id],"include":["embeddings","metadatas"]})),
            Some(json!({"ids":[row.memory_id],"embeddings":[row.vector],"metadatas":[metadata]})),
        );
        let hits = adapter
            .search(
                &[1.0, 0.0],
                1,
                &VectorFilter {
                    scope: ProjectScope::Global,
                    only_reusable: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(
            hits,
            vec![VectorHit {
                memory_id: row.memory_id,
                similarity: 0.75
            }]
        );
        http.reply(
            Method::POST,
            &format!("{collection}/delete"),
            Some(json!({"ids":[row.memory_id]})),
            Some(Value::Null),
        );
        adapter.delete(&[row.memory_id]).await.unwrap();
        http.reply(Method::GET, &name_path, None, Some(details));
        adapter.health_check().await.unwrap();
        http.assert_complete();
    }
}
