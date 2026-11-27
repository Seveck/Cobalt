use std::collections::HashSet;
use std::io::{Cursor, Read};
use std::path::Path;

use cobalt_core::error::{CobaltError, Result};
use cobalt_core::traits::OcrEngine;
use flate2::read::ZlibDecoder;
use image::{DynamicImage, ExtendedColorType, GrayImage, ImageEncoder, ImageReader, Limits, Pixel};
use lopdf::content::{Content, Operation};
use lopdf::filters::png::{FilterType, decode_row};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use ocrs::{ImageSource, OcrEngineParams};
use rten::Model;

use crate::jobs::{Cancellation, Progress};

const MAX_PIXELS: u32 = 40_000_000;
const MAX_DECODE_BYTES: u64 = 256 * 1024 * 1024;

/// CPU-only OCR backed by the installed detection and recognition ONNX files.
pub struct OcrsEngine(ocrs::OcrEngine);

impl OcrsEngine {
    /// Loads the verified files returned by `EngineManager::ocr_model_paths`.
    pub fn from_paths(detection: impl AsRef<Path>, recognition: impl AsRef<Path>) -> Result<Self> {
        let detection_model = Model::load_file(detection).map_err(|error| {
            CobaltError::Internal(format!("cannot load OCR detection model: {error}"))
        })?;
        let recognition_model = Model::load_file(recognition).map_err(|error| {
            CobaltError::Internal(format!("cannot load OCR recognition model: {error}"))
        })?;
        ocrs::OcrEngine::new(OcrEngineParams {
            detection_model: Some(detection_model),
            recognition_model: Some(recognition_model),
            ..Default::default()
        })
        .map(Self)
        .map_err(ocr_error)
    }
}

impl OcrEngine for OcrsEngine {
    fn recognize(&self, encoded: &[u8]) -> Result<String> {
        let mut reader = ImageReader::new(Cursor::new(encoded))
            .with_guessed_format()
            .map_err(image_error)?;
        let mut limits = Limits::default();
        limits.max_alloc = Some(MAX_DECODE_BYTES);
        reader.limits(limits);
        let decoded = reader.decode().map_err(image_error)?;
        let image = downscale(decoded);
        let gray = if image.color().has_alpha() {
            let rgba = image.into_rgba8();
            GrayImage::from_fn(rgba.width(), rgba.height(), |x, y| {
                let pixel = rgba.get_pixel(x, y);
                let alpha = u16::from(pixel[3]);
                let luma = u16::from(pixel.to_luma()[0]);
                image::Luma([((luma * alpha + 255 * (255 - alpha)) / 255) as u8])
            })
        } else {
            image.into_luma8()
        };
        let source =
            ImageSource::from_bytes(gray.as_raw(), gray.dimensions()).map_err(image_error)?;
        let input = self.0.prepare_input(source).map_err(ocr_error)?;
        drop(gray);
        self.0.get_text(&input).map_err(ocr_error)
    }
}

fn downscale(image: DynamicImage) -> DynamicImage {
    let size = (image.width(), image.height());
    let capped = capped_dimensions(size.0, size.1);
    if capped == size {
        image
    } else {
        image.thumbnail_exact(capped.0, capped.1)
    }
}

fn capped_dimensions(width: u32, height: u32) -> (u32, u32) {
    let pixels = u64::from(width) * u64::from(height);
    if pixels <= u64::from(MAX_PIXELS) {
        return (width, height);
    }
    let scale = (f64::from(MAX_PIXELS) / pixels as f64).sqrt();
    let width = ((f64::from(width) * scale) as u32).clamp(1, MAX_PIXELS);
    let height = ((f64::from(height) * scale) as u32).clamp(1, MAX_PIXELS / width);
    (width, height)
}

fn image_error(error: impl std::fmt::Display) -> CobaltError {
    CobaltError::InvalidInput(format!("cannot decode image for OCR: {error}"))
}

fn ocr_error(error: ocrs::OcrError) -> CobaltError {
    CobaltError::Internal(format!("OCR failed: {error}"))
}

pub(crate) fn recognize_pdf(
    pdf: &Document,
    engine: &dyn OcrEngine,
    cancellation: &Cancellation,
    progress: &Progress,
) -> Result<String> {
    let pages = pdf.get_pages();
    let total = pages.len();
    let mut text = String::new();
    progress.reading_units(0, total);
    for (index, page) in pages.into_values().enumerate() {
        cancellation.check()?;
        for image in page_images(pdf, page) {
            cancellation.check()?;
            let recognized = match image.filters().as_deref() {
                Ok([b"DCTDecode"]) => engine.recognize(&image.content)?,
                Ok([b"FlateDecode"]) => match flate_image(image)? {
                    Some(png) => engine.recognize(&png)?,
                    None => continue,
                },
                _ => continue,
            };
            let recognized = recognized.trim();
            if !recognized.is_empty() {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(recognized);
            }
        }
        cancellation.check()?;
        progress.reading_units(index + 1, total);
    }
    Ok(text)
}

fn page_resources(pdf: &Document, mut page: ObjectId) -> Option<&Dictionary> {
    let mut seen = HashSet::new();
    while seen.insert(page) {
        let dict = pdf.get_dictionary(page).ok()?;
        if dict.has(b"Resources") {
            return pdf.get_dict_in_dict(dict, b"Resources").ok();
        }
        page = dict.get(b"Parent").and_then(Object::as_reference).ok()?;
    }
    None
}

fn page_images(pdf: &Document, page: ObjectId) -> impl Iterator<Item = &Stream> {
    let mut pending = Vec::new();
    let mut seen = HashSet::new();
    // Shared resource dictionaries may declare images drawn on other pages.
    if let Some(resources) = page_resources(pdf, page)
        && let Ok(content) = pdf.get_and_decode_page_content(page)
    {
        queue_xobjects(pdf, resources, &content.operations, &mut pending);
    }
    std::iter::from_fn(move || {
        while let Some((resources, value)) = pending.pop() {
            let Ok((id, object)) = pdf.dereference(value) else {
                continue;
            };
            if id.is_some_and(|id| !seen.insert(id)) {
                continue;
            }
            let Ok(stream) = object.as_stream() else {
                continue;
            };
            match stream.dict.get(b"Subtype").and_then(Object::as_name) {
                Ok(b"Image") => return Some(stream),
                Ok(b"Form") => {
                    let resources = pdf
                        .get_dict_in_dict(&stream.dict, b"Resources")
                        .unwrap_or(resources);
                    if let Ok(bytes) = stream.get_plain_content()
                        && let Ok(content) = Content::decode(&bytes)
                    {
                        queue_xobjects(pdf, resources, &content.operations, &mut pending);
                    }
                }
                _ => {}
            }
        }
        None
    })
}

fn queue_xobjects<'a>(
    pdf: &'a Document,
    resources: &'a Dictionary,
    operations: &[Operation],
    pending: &mut Vec<(&'a Dictionary, &'a Object)>,
) {
    let Ok(objects) = pdf.get_dict_in_dict(resources, b"XObject") else {
        return;
    };
    pending.extend(operations.iter().rev().filter_map(|op| {
        if op.operator != "Do" {
            return None;
        }
        let name = op.operands.first()?.as_name().ok()?;
        Some((resources, objects.get(name).ok()?))
    }));
}

fn flate_image(stream: &Stream) -> Result<Option<Vec<u8>>> {
    let dict = &stream.dict;
    let (channels, color) = match dict.get(b"ColorSpace").and_then(Object::as_name) {
        Ok(b"DeviceGray") => (1, ExtendedColorType::L8),
        Ok(b"DeviceRGB") => (3, ExtendedColorType::Rgb8),
        _ => return Ok(None),
    };
    let integer = |key: &[u8]| dict.get(key).and_then(Object::as_i64);
    let bits = match integer(b"BitsPerComponent") {
        Ok(bits @ (1 | 2 | 4 | 8 | 16)) => bits as usize,
        _ => return Ok(None),
    };
    let dimensions = |key| {
        integer(key)
            .ok()
            .and_then(|value| u32::try_from(value).ok())
            .filter(|&value| value != 0)
            .ok_or_else(|| image_error("invalid PDF image dimensions"))
    };
    let (width, height) = (dimensions(b"Width")?, dimensions(b"Height")?);
    let params = dict.get(b"DecodeParms").ok().and_then(|value| {
        value
            .as_dict()
            .ok()
            .or_else(|| value.as_array().ok()?.first()?.as_dict().ok())
    });
    let predictor = params
        .and_then(|params| params.get(b"Predictor").and_then(Object::as_i64).ok())
        .unwrap_or(1);
    let png_filter = matches!(predictor, 10..=15);
    if !png_filter && !matches!(predictor, 1 | 2) {
        return Ok(None);
    }
    let row_bytes = (u64::from(width) * (channels * bits) as u64).div_ceil(8);
    if (row_bytes + u64::from(png_filter)) > MAX_DECODE_BYTES / u64::from(height) {
        return Err(image_error("PDF image exceeds the decoding size limit"));
    }

    let (out_width, out_height) = capped_dimensions(width, height);
    let mut pixels = Vec::with_capacity(out_width as usize * out_height as usize * channels);
    let mut decoder = ZlibDecoder::new(stream.content.as_slice());
    let mut row = vec![0; row_bytes as usize];
    let mut previous = if png_filter {
        vec![0; row.len()]
    } else {
        Vec::new()
    };
    let mut out_y = 0;
    for y in 0..height {
        let filter = if png_filter {
            let mut tag = [0];
            decoder.read_exact(&mut tag).map_err(image_error)?;
            Some(
                FilterType::try_from(tag[0])
                    .map_err(|()| image_error("invalid PDF image predictor"))?,
            )
        } else {
            None
        };
        decoder.read_exact(&mut row).map_err(image_error)?;
        if let Some(filter) = filter {
            undo_png_filter(filter, (channels * bits).div_ceil(8), &previous, &mut row);
        }
        if out_y < out_height && nearest_pixel(out_y, height, out_height) == y {
            append_samples(
                &mut pixels,
                &row,
                width,
                out_width,
                channels,
                bits,
                predictor == 2,
            );
            out_y += 1;
        }
        if png_filter {
            std::mem::swap(&mut previous, &mut row);
        }
    }
    if decoder.read(&mut [0]).map_err(image_error)? != 0 {
        return Err(image_error(
            "PDF image contains more data than its dimensions allow",
        ));
    }

    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(&pixels, out_width, out_height, color)
        .map_err(image_error)?;
    Ok(Some(png))
}

fn undo_png_filter(filter: FilterType, bytes_per_pixel: usize, previous: &[u8], row: &mut [u8]) {
    if filter != FilterType::Avg {
        decode_row(filter, bytes_per_pixel, previous, row);
        return;
    }
    // lopdf 0.40 averages only the above byte for pixels with a left neighbor.
    for (i, &above) in previous.iter().enumerate() {
        let left = i.checked_sub(bytes_per_pixel).map_or(0, |left| row[left]);
        row[i] = row[i].wrapping_add(left.midpoint(above));
    }
}

fn nearest_pixel(index: u32, source: u32, target: u32) -> u32 {
    (u64::from(index) * u64::from(source) / u64::from(target)) as u32
}

fn append_samples(
    pixels: &mut Vec<u8>,
    row: &[u8],
    width: u32,
    out_width: u32,
    channels: usize,
    bits: usize,
    horizontal_predictor: bool,
) {
    if bits == 8 && !horizontal_predictor && width == out_width {
        pixels.extend_from_slice(row);
        return;
    }
    let mask = (1u32 << bits) - 1;
    let mut previous = [0; 3];
    let mut x = 0;
    for out_x in 0..out_width {
        let source_x = nearest_pixel(out_x, width, out_width);
        if !horizontal_predictor {
            x = source_x;
        }
        // TIFF horizontal differencing requires the intervening samples too.
        while x <= source_x {
            for (channel, previous) in previous[..channels].iter_mut().enumerate() {
                let bit = (x as usize * channels + channel) * bits;
                let byte = bit / 8;
                let value = if bits == 16 {
                    u32::from(u16::from_be_bytes([row[byte], row[byte + 1]]))
                } else {
                    (u32::from(row[byte]) >> (8 - bits - bit % 8)) & mask
                };
                *previous = if horizontal_predictor {
                    (*previous + value) & mask
                } else {
                    value
                };
            }
            x += 1;
        }
        pixels.extend(
            previous[..channels]
                .iter()
                .map(|value| ((value * 255) / mask) as u8),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_pixel_area_for_normal_and_extremely_wide_images() {
        assert_eq!(capped_dimensions(8000, 5000), (8000, 5000));
        assert_eq!(capped_dimensions(10000, 10000), (6324, 6324));
        assert_eq!(capped_dimensions(u32::MAX, 1), (MAX_PIXELS, 1));
        assert_eq!(capped_dimensions(1, u32::MAX), (1, MAX_PIXELS));
    }
}
