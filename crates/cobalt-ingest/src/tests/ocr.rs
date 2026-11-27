use super::*;

use std::io::Write;

use cobalt_core::traits::OcrEngine;
use flate2::{Compression, write::ZlibEncoder};
use image::{DynamicImage, GrayImage, ImageFormat, Luma};
use lopdf::content::{Content, Operation};
use lopdf::{Document, Object, Stream, dictionary};

const PNG: &str = "scan.png";
const PDF: &str = "scan.pdf";

struct PixelOcrMock;

impl OcrEngine for PixelOcrMock {
    fn recognize(&self, encoded: &[u8]) -> Result<String> {
        let gray = image::load_from_memory(encoded).unwrap().into_luma8();
        assert_eq!(gray.dimensions(), (4, 2));
        Ok(match gray.get_pixel(2, 1)[0] {
            20 => "First",
            80 => "Second",
            170 => "Third",
            255 => " \n ",
            other => panic!("unexpected pixel {other}"),
        }
        .into())
    }
}

fn encoded_gray(value: u8, format: ImageFormat) -> Vec<u8> {
    let image = DynamicImage::ImageLuma8(GrayImage::from_pixel(4, 2, Luma([value])));
    let mut cursor = Cursor::new(Vec::new());
    image.write_to(&mut cursor, format).unwrap();
    cursor.into_inner()
}

fn flate(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}

fn image_stream(filter: &str, space: &str, data: Vec<u8>) -> Stream {
    Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Image",
            "Width" => 4, "Height" => 2, "BitsPerComponent" => 8,
            "ColorSpace" => Object::Name(space.as_bytes().to_vec()),
            "Filter" => Object::Name(filter.as_bytes().to_vec()),
        },
        data,
    )
}

fn build_scanned_pdf(path: &Path) {
    let mut pdf = Document::with_version("1.5");
    let pages = pdf.new_object_id();
    let second_page = pdf.new_object_id();
    let first_page = pdf.new_object_id();
    let jpeg = pdf.add_object(image_stream(
        "DCTDecode",
        "DeviceGray",
        encoded_gray(20, ImageFormat::Jpeg),
    ));
    let mut rgb_samples = vec![1, 80, 80, 80];
    rgb_samples.extend([0; 9]); // PNG Sub predictor, first RGB pixel then three differences.
    rgb_samples.extend([3, 40, 40, 40]);
    rgb_samples.extend([0; 9]); // PNG Average predictor, identical second row.
    let mut rgb = image_stream("FlateDecode", "DeviceRGB", flate(&rgb_samples));
    rgb.dict.set(
        "DecodeParms",
        vec![Object::Dictionary(
            dictionary! { "Predictor" => 15, "Colors" => 3, "Columns" => 4 },
        )],
    );
    let rgb = pdf.add_object(rgb);
    let gray = pdf.add_object(image_stream("FlateDecode", "DeviceGray", flate(&[170; 8])));
    let skipped = pdf.add_object(image_stream("JPXDecode", "DeviceGray", vec![0]));
    let form = pdf.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 4.into(), 2.into()],
            "Resources" => dictionary! { "XObject" => dictionary! { "Gray" => gray } },
        },
        b"/Gray Do".to_vec(),
    ));
    let first_content = pdf.add_object(pdf_content(&[b"Jpeg", b"Skip", b"Rgb"]));
    let second_content = pdf.add_object(pdf_content(&[b"Form"]));
    pdf.objects.insert(
        first_page,
        Object::Dictionary(
            dictionary! { "Type" => "Page", "Parent" => pages, "Contents" => first_content },
        ),
    );
    pdf.objects.insert(
        second_page,
        Object::Dictionary(
            dictionary! { "Type" => "Page", "Parent" => pages, "Contents" => second_content },
        ),
    );
    pdf.objects.insert(
        pages,
        Object::Dictionary(dictionary! {
            "Type" => "Pages", "Count" => 2, "Kids" => vec![first_page.into(), second_page.into()],
            "Resources" => dictionary! { "XObject" => dictionary! { "Form" => form, "Rgb" => rgb, "Skip" => skipped, "Jpeg" => jpeg } },
            "MediaBox" => vec![0.into(), 0.into(), 4.into(), 2.into()],
        }),
    );
    let root = pdf.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
    pdf.trailer.set("Root", root);
    pdf.save(path).unwrap();
}

fn pdf_content(names: &[&[u8]]) -> Stream {
    let content = Content {
        operations: names
            .iter()
            .map(|name| Operation::new("Do", vec![Object::Name(name.to_vec())]))
            .collect::<Vec<_>>(),
    };
    Stream::new(dictionary! {}, content.encode().unwrap())
}

#[tokio::test]
async fn ingests_image_and_scanned_pdf_in_page_order() {
    let dir = tempfile::tempdir().unwrap();
    let (store, ingest, _) = setup(dir.path(), "test").await;
    let ingest = ingest.with_ocr(Arc::new(PixelOcrMock));
    let scan_dir = dir.path().join("scans");
    std::fs::create_dir(&scan_dir).unwrap();
    std::fs::write(scan_dir.join(PNG), encoded_gray(80, ImageFormat::Png)).unwrap();
    build_scanned_pdf(&scan_dir.join(PDF));
    let report = ingest
        .ingest_paths(req(&scan_dir), quiet_progress())
        .await
        .unwrap();
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(report.memories_created, 2);
    let nodes = store.graph(GraphQuery::default()).await.unwrap().nodes;
    assert_eq!(nodes.len(), 2);
    for node in nodes {
        let memory = store.get_memory(node.id).await.unwrap().unwrap();
        assert_eq!(memory.category, MemoryCategory::Ocr);
        match memory.source_type {
            SourceType::Pdf => assert_eq!(memory.content, "First\nSecond\nThird"),
            SourceType::Image => assert_eq!(memory.content, "Second"),
            other => panic!("unexpected source: {other:?}"),
        }
    }
}

#[tokio::test]
async fn reports_missing_disabled_and_empty_ocr() {
    let dir = tempfile::tempdir().unwrap();
    let (store, ingest, _) = setup(dir.path(), "test").await;
    let image = dir.path().join(PNG);
    let pdf = dir.path().join(PDF);
    std::fs::write(&image, encoded_gray(255, ImageFormat::Png)).unwrap();
    build_scanned_pdf(&pdf);
    for file in [&image, &pdf] {
        let report = ingest
            .ingest_paths(req(file), quiet_progress())
            .await
            .unwrap();
        assert_eq!(report.skipped_ignored, 1);
        assert!(
            report.errors[0]
                .message
                .contains("OCR is not installed: install it in Settings → OCR")
        );
    }

    let ingest = ingest.with_ocr(Arc::new(PixelOcrMock));
    let mut disabled = req(&pdf);
    disabled.ocr = false;
    let report = ingest
        .ingest_paths(disabled, quiet_progress())
        .await
        .unwrap();
    assert!(report.errors[0].message.contains("OCR, which is disabled"));

    let report = ingest
        .ingest_paths(req(&image), quiet_progress())
        .await
        .unwrap();
    assert_eq!(report.skipped_ignored, 1);
    assert!(report.errors[0].message.contains("OCR found no text"));
    assert_eq!(report.memories_created, 0);
    assert!(source_at(&store, &image).await.is_none());
    assert!(source_at(&store, &pdf).await.is_none());
}

struct CancelOcrMock {
    cancellation: Cancellation,
    calls: AtomicUsize,
}

impl OcrEngine for CancelOcrMock {
    fn recognize(&self, encoded: &[u8]) -> Result<String> {
        if self.calls.fetch_add(1, Ordering::Relaxed) == 1 {
            self.cancellation.cancel();
        }
        PixelOcrMock.recognize(encoded)
    }
}

#[test]
fn scanned_pdf_stops_before_the_next_page_on_cancellation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(PDF);
    build_scanned_pdf(&path);
    let pdf = Document::load(path).unwrap();
    let engine = CancelOcrMock {
        cancellation: Cancellation::default(),
        calls: AtomicUsize::new(0),
    };
    let result =
        crate::ocr::recognize_pdf(&pdf, &engine, &engine.cancellation, &Default::default());
    assert!(matches!(result, Err(CobaltError::Cancelled)));
    assert_eq!(engine.calls.load(Ordering::Relaxed), 2);
}
