use std::path::Path;
use std::sync::Mutex;

use cobalt_core::error::{CobaltError, Result};
use cobalt_core::traits::OcrEngine;
use image::{Rgb, RgbImage, imageops};
use ort::session::Session;
use ort::value::Tensor;
use rten_imageproc::{
    BoundingRect, IMAGENET_MEAN, IMAGENET_STD_DEV, Point, PointF, RetrievalMode, RotatedRect, Vec2,
    find_contours,
};
use rten_tensor::{AsView, NdTensor};
use serde::Deserialize;

use crate::ocr::decode_image;

const DET_LONG_SIDE: f32 = 960.0;
const DET_STRIDE: f32 = 32.0;
const DB_THRESHOLD: f32 = 0.3;
const DB_BOX_THRESHOLD: f32 = 0.6;
const DB_UNCLIP_RATIO: f32 = 1.5;
const DB_MIN_SIZE: f32 = 3.0;
const DB_MAX_CANDIDATES: usize = 1000;
const REC_HEIGHT: usize = 48;
const REC_MIN_WIDTH: usize = 320;
const REC_MAX_WIDTH: usize = 3200;

type Quad = [PointF; 4];

/// PP-OCRv5 detection and Latin-script recognition using the shared ONNX Runtime.
pub struct PaddleOcrEngine {
    detection: Mutex<Session>,
    recognition: Mutex<Session>,
    alphabet: Vec<String>,
}

impl PaddleOcrEngine {
    /// Loads the detection, recognition and dictionary paths from installed OCR model files.
    /// The dictionary is the recognizer's PaddleOCR `inference.yml`.
    pub fn from_files(
        detection: impl AsRef<Path>,
        recognition: impl AsRef<Path>,
        dictionary: impl AsRef<Path>,
    ) -> Result<Self> {
        let yaml = std::fs::read(dictionary).map_err(paddle_error("reading dictionary"))?;
        let alphabet = parse_dictionary(&yaml)?;
        Ok(Self {
            detection: Mutex::new(load_session(detection.as_ref(), "detection")?),
            recognition: Mutex::new(load_session(recognition.as_ref(), "recognition")?),
            alphabet,
        })
    }

    fn detect(&self, source: &RgbImage) -> Result<Vec<Quad>> {
        let width = source.width();
        let height = source.height();
        let scale = DET_LONG_SIDE / width.max(height) as f32;
        let align =
            |size| (((size as f32 * scale / DET_STRIDE).round().max(1.0)) * DET_STRIDE) as u32;
        let resized = imageops::resize(
            source,
            align(width),
            align(height),
            imageops::FilterType::Triangle,
        );
        let (det_width, det_height) = (resized.width() as usize, resized.height() as usize);
        let plane = det_width * det_height;
        let mut values = vec![0.0; 3 * plane];
        for (i, pixel) in resized.pixels().enumerate() {
            for channel in 0..3 {
                values[channel * plane + i] = (f32::from(pixel[2 - channel]) / 255.0
                    - IMAGENET_MEAN[channel])
                    / IMAGENET_STD_DEV[channel];
            }
        }

        let tensor = Tensor::from_array(([1, 3, det_height, det_width], values))
            .map_err(paddle_error("detection"))?;
        let mut session = self
            .detection
            .lock()
            .map_err(paddle_error("locking detection session"))?;
        let outputs = session
            .run(ort::inputs![tensor])
            .map_err(paddle_error("detection"))?;
        let output = outputs
            .values()
            .next()
            .ok_or_else(|| paddle_error("detection")("missing output"))?;
        let (shape, probabilities) = output
            .try_extract_tensor::<f32>()
            .map_err(paddle_error("detection"))?;
        let map_size = match **shape {
            [1, 1, h, w] if h > 0 && w > 0 => (w as usize, h as usize),
            _ => {
                return Err(paddle_error("detection")(
                    "expected a [1, 1, H, W] probability map",
                ));
            }
        };
        let mut boxes = db_boxes(probabilities, map_size.0, map_size.1);
        sort_reading_order(&mut boxes);
        let x_scale = width as f32 / map_size.0 as f32;
        let y_scale = height as f32 / map_size.1 as f32;
        Ok(boxes
            .into_iter()
            .map(|rect| {
                rect.orient_towards(Vec2::from_yx(1.0, 0.0))
                    .corners()
                    .map(|point| PointF::from_yx(point.y * y_scale, point.x * x_scale))
            })
            .collect())
    }

    fn recognize_line(&self, image: &RgbImage, quad: Quad) -> Result<String> {
        let (width, values) = recognition_input(image, quad);
        let tensor = Tensor::from_array(([1, 3, REC_HEIGHT, width], values))
            .map_err(paddle_error("recognition"))?;
        let mut session = self
            .recognition
            .lock()
            .map_err(paddle_error("locking recognition session"))?;
        let outputs = session
            .run(ort::inputs![tensor])
            .map_err(paddle_error("recognition"))?;
        let output = outputs
            .values()
            .next()
            .ok_or_else(|| paddle_error("recognition")("missing output"))?;
        let (shape, scores) = output
            .try_extract_tensor::<f32>()
            .map_err(paddle_error("recognition"))?;
        match **shape {
            [1, _, classes] if classes as usize == self.alphabet.len() => {
                Ok(ctc_decode(scores, &self.alphabet))
            }
            _ => Err(paddle_error("recognition")(format!(
                "expected [1, T, {}] scores for the CTC dictionary, got {shape:?}",
                self.alphabet.len()
            ))),
        }
    }
}

impl OcrEngine for PaddleOcrEngine {
    fn recognize(&self, encoded: &[u8]) -> Result<String> {
        let decoded = decode_image(encoded)?;
        let image = if decoded.color().has_alpha() {
            let rgba = decoded.into_rgba8();
            RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
                let pixel = rgba.get_pixel(x, y);
                let alpha = u16::from(pixel[3]);
                Rgb(std::array::from_fn(|channel| {
                    ((u16::from(pixel[channel]) * alpha + 255 * (255 - alpha)) / 255) as u8
                }))
            })
        } else {
            decoded.into_rgb8()
        };

        let mut lines = Vec::new();
        for quad in self.detect(&image)? {
            let line = self.recognize_line(&image, quad)?;
            if !line.trim().is_empty() {
                lines.push(line);
            }
        }
        Ok(lines.join("\n"))
    }
}

fn paddle_error<E: std::fmt::Display>(stage: &'static str) -> impl FnOnce(E) -> CobaltError {
    move |message| CobaltError::Internal(format!("PaddleOCR {stage}: {message}"))
}

fn load_session(path: &Path, stage: &'static str) -> Result<Session> {
    Session::builder()
        .and_then(|builder| builder.with_intra_threads(2).map_err(ort::Error::from))
        .and_then(|mut builder| builder.commit_from_file(path))
        .map_err(paddle_error(stage))
}

#[derive(Deserialize)]
struct InferenceConfig {
    #[serde(rename = "PostProcess")]
    post_process: RecognitionConfig,
}

#[derive(Deserialize)]
struct RecognitionConfig {
    name: String,
    character_dict: Vec<String>,
    #[serde(default = "default_use_space")]
    use_space_char: bool,
}

fn default_use_space() -> bool {
    true
}

fn parse_dictionary(yaml: &[u8]) -> Result<Vec<String>> {
    let config: InferenceConfig =
        serde_yaml_ng::from_slice(yaml).map_err(paddle_error("reading dictionary"))?;
    let RecognitionConfig {
        name,
        character_dict,
        use_space_char,
    } = config.post_process;
    if name != "CTCLabelDecode"
        || character_dict.is_empty()
        || character_dict.iter().any(String::is_empty)
    {
        return Err(paddle_error("reading dictionary")(
            "expected a nonempty PostProcess.character_dict for CTCLabelDecode",
        ));
    }
    let mut alphabet = Vec::with_capacity(character_dict.len() + 2);
    alphabet.push(String::new()); // Blank index 0.
    alphabet.extend(character_dict);
    if use_space_char {
        alphabet.push(" ".into());
    }
    Ok(alphabet)
}

fn ctc_decode(scores: &[f32], alphabet: &[String]) -> String {
    let mut previous = 0;
    let mut text = String::new();
    for step in scores.chunks_exact(alphabet.len()) {
        // Keep the first class on ties, as in NumPy argmax.
        let mut best = 0;
        for (index, &score) in step.iter().enumerate().skip(1) {
            if score > step[best] {
                best = index;
            }
        }
        if best != 0 && best != previous {
            text.push_str(&alphabet[best]);
        }
        previous = best;
    }
    text
}

fn db_boxes(scores: &[f32], width: usize, height: usize) -> Vec<RotatedRect> {
    let mask = NdTensor::from_data(
        [height, width],
        scores
            .iter()
            .map(|&score| score > DB_THRESHOLD)
            .collect::<Vec<_>>(),
    );
    find_contours(mask.view(), RetrievalMode::List)
        .iter()
        .take(DB_MAX_CANDIDATES)
        .filter_map(|contour| {
            let rect = contour_box(contour)?;
            if rect.width().min(rect.height()) < DB_MIN_SIZE
                || box_score(scores, width, height, rect) < DB_BOX_THRESHOLD
            {
                return None;
            }
            // The minimum box of a rounded offset of a rectangle extends by d on each edge.
            let distance = DB_UNCLIP_RATIO * rect.area() / (2.0 * (rect.width() + rect.height()));
            let rect = rect.expanded(2.0 * distance, 2.0 * distance);
            (rect.width().min(rect.height()) >= DB_MIN_SIZE + 2.0).then_some(rect)
        })
        .collect()
}

// Use exact integer turns for the hull. Float angle sorting can lose the
// hull of a long, nearly collinear contour when several angles round equally.
fn contour_box(contour: &[Point]) -> Option<RotatedRect> {
    fn hull_half(points: impl Iterator<Item = Point>) -> Vec<Point> {
        let mut half: Vec<Point> = Vec::new();
        for point in points {
            while let [.., a, b] = half.as_slice() {
                let cross = i64::from(b.x - a.x) * i64::from(point.y - a.y)
                    - i64::from(b.y - a.y) * i64::from(point.x - a.x);
                if cross > 0 {
                    break;
                }
                half.pop();
            }
            half.push(point);
        }
        half.pop(); // The other half includes this endpoint.
        half
    }

    let mut points = contour.to_vec();
    points.sort_unstable_by_key(|point| (point.x, point.y));
    points.dedup();
    let mut hull = hull_half(points.iter().copied());
    hull.extend(hull_half(points.iter().rev().copied()));
    if hull.len() < 3 {
        return None;
    }

    let vertices: Vec<_> = hull.into_iter().map(|point| point.to_f32()).collect();
    vertices
        .iter()
        .zip(vertices.iter().cycle().skip(1))
        .map(|(&start, &end)| {
            let along = start.vec_to(end).normalized();
            let across = along.perpendicular();
            let origin = start.to_vec();
            let bounds = |axis: Vec2| {
                vertices
                    .iter()
                    .map(|&point| axis.dot(start.vec_to(point)))
                    .fold((f32::INFINITY, f32::NEG_INFINITY), |(min, max), value| {
                        (min.min(value), max.max(value))
                    })
            };
            let (left, right) = bounds(along);
            let (top, bottom) = bounds(across);
            let center = origin + along * left.midpoint(right) + across * top.midpoint(bottom);
            RotatedRect::new(
                PointF::from_yx(center.y, center.x),
                across,
                right - left,
                bottom - top,
            )
        })
        .min_by(|a, b| a.area().total_cmp(&b.area()))
}

fn box_score(scores: &[f32], width: usize, height: usize, rect: RotatedRect) -> f32 {
    let bounds = rect.bounding_rect();
    let mut total = 0.0;
    let mut count = 0;
    for y in
        bounds.top().ceil() as usize..=bounds.bottom().floor().min((height - 1) as f32) as usize
    {
        for x in
            bounds.left().ceil() as usize..=bounds.right().floor().min((width - 1) as f32) as usize
        {
            if rect.contains(PointF::from_yx(y as f32, x as f32)) {
                total += scores[y * width + x];
                count += 1;
            }
        }
    }
    total / count.max(1) as f32
}

fn sort_reading_order(boxes: &mut [RotatedRect]) {
    let center = |rect: &RotatedRect| rect.center().y;
    boxes.sort_by(|a, b| center(a).total_cmp(&center(b)));
    let mut remaining = boxes;
    while let Some(first) = remaining.first() {
        let row_size = remaining
            .iter()
            .take_while(|rect| {
                let tolerance = first
                    .bounding_rect()
                    .height()
                    .min(rect.bounding_rect().height())
                    * 0.5;
                center(rect) - center(first) <= tolerance
            })
            .count();
        let (row, rest) = remaining.split_at_mut(row_size);
        row.sort_by(|a, b| {
            a.bounding_rect()
                .left()
                .total_cmp(&b.bounding_rect().left())
        });
        remaining = rest;
    }
}

fn recognition_input(image: &RgbImage, mut quad: Quad) -> (usize, Vec<f32>) {
    let width = quad[0].distance(quad[1]);
    let height = quad[0].distance(quad[3]);
    let (width, height) = if height >= 1.5 * width {
        quad.rotate_left(1);
        (height, width)
    } else {
        (width, height)
    };
    let resized_width =
        ((REC_HEIGHT as f32 * width / height).ceil() as usize).clamp(1, REC_MAX_WIDTH);
    let padded_width = resized_width.max(REC_MIN_WIDTH);
    let plane = padded_width * REC_HEIGHT;
    let mut values = vec![0.0; 3 * plane];
    // Scaling a detector rectangle back to the source yields a parallelogram. Sample its
    // deskewed crop directly at recognition resolution and replicate image edge pixels.
    let origin = quad[0].to_vec();
    let across = (quad[1].to_vec() - origin) * (1.0 / resized_width as f32);
    let down = (quad[3].to_vec() - origin) * (1.0 / REC_HEIGHT as f32);
    for y in 0..REC_HEIGHT {
        let row = origin + down * (y as f32 + 0.5);
        for x in 0..resized_width {
            let at = row + across * (x as f32 + 0.5);
            let pixel = bilinear_rgb(image, at);
            for channel in 0..3 {
                values[channel * plane + y * padded_width + x] = pixel[2 - channel] / 127.5 - 1.0;
            }
        }
    }
    (padded_width, values)
}

fn bilinear_rgb(image: &RgbImage, at: Vec2) -> [f32; 3] {
    let x = at.x.clamp(0.0, (image.width() - 1) as f32);
    let y = at.y.clamp(0.0, (image.height() - 1) as f32);
    let (left, top) = (x.floor() as u32, y.floor() as u32);
    let right = (left + 1).min(image.width() - 1);
    let bottom = (top + 1).min(image.height() - 1);
    let (fx, fy) = (x - left as f32, y - top as f32);
    let [tl, tr, bl, br] = [(left, top), (right, top), (left, bottom), (right, bottom)]
        .map(|(x, y)| image.get_pixel(x, y));
    std::array::from_fn(|c| {
        let upper = f32::from(tl[c]) * (1.0 - fx) + f32::from(tr[c]) * fx;
        let lower = f32::from(bl[c]) * (1.0 - fx) + f32::from(br[c]) * fx;
        upper * (1.0 - fy) + lower * fy
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_ctc_blanks_repeats_and_space_using_the_yaml_order() -> Result<()> {
        let alphabet = parse_dictionary(
            b"PostProcess:\n  name: CTCLabelDecode\n  character_dict: [a, \"\\u00f1\", '!']\n",
        )?;
        assert_eq!(alphabet, ["", "a", "ñ", "!", " "]);
        let classes = [0, 1, 1, 0, 1, 4, 4, 2, 2, 3, 0];
        let scores: Vec<_> = classes
            .into_iter()
            .flat_map(|best| {
                (0..alphabet.len()).map(move |class| if best == class { 0.9 } else { 0.01 })
            })
            .collect();
        assert_eq!(ctc_decode(&scores, &alphabet), "aa ñ!");
        assert_eq!(ctc_decode(&[0.5, 0.5, 0.0, 0.0, 0.0], &alphabet), "");
        Ok(())
    }

    #[test]
    fn rejects_invalid_ctc_dictionaries_and_honors_explicit_space_setting() -> Result<()> {
        assert!(
            parse_dictionary(b"PostProcess: {name: CTCLabelDecode, character_dict: []}").is_err()
        );
        assert!(parse_dictionary(b"PostProcess: {name: NotCTC, character_dict: [a]}").is_err());
        assert_eq!(
            parse_dictionary(b"PostProcess: {name: CTCLabelDecode, character_dict: ['0'], use_space_char: false}")?,
            ["", "0"]
        );
        Ok(())
    }

    #[test]
    fn db_rejects_low_scores_and_small_components_and_unclips_the_rotated_box() {
        let (width, height) = (52, 40);
        let mut scores = vec![0.0; width * height];
        for y in 5..12 {
            scores[y * width + 28..y * width + 47].fill(0.5);
        }
        for y in 4..6 {
            scores[y * width + 3..y * width + 13].fill(0.95);
        }
        for x in 8..26 {
            let top = 20 + (x - 8) / 2;
            for y in top..top + 6 {
                scores[y * width + x] = 0.95;
            }
        }
        let boxes = db_boxes(&scores, width, height);
        assert_eq!(boxes.len(), 1, "{boxes:?}");
        let rect = boxes[0].orient_towards(Vec2::from_yx(1.0, 0.0));
        assert!(rect.up_axis().x.abs() > 0.3, "{rect:?}");
        assert!(rect.width() > 22.0 && rect.height() > 9.0, "{rect:?}");
    }

    #[test]
    fn reads_jittered_rows_from_left_to_right() {
        let mut boxes = [(9.0, 60.0), (30.0, 5.0), (12.0, 5.0)].map(|(y, x)| {
            RotatedRect::new(PointF::from_yx(y, x), Vec2::from_yx(1.0, 0.0), 10.0, 8.0)
        });
        sort_reading_order(&mut boxes);
        assert_eq!(boxes.map(|rect| rect.center().y), [12.0, 9.0, 30.0]);
    }

    #[test]
    fn crops_rotated_lines_into_bgr_with_zero_padding() {
        let image = RgbImage::from_fn(50, 50, |x, _| {
            if x < 25 {
                Rgb([255, 0, 0])
            } else {
                Rgb([0, 0, 255])
            }
        });
        let quad = [(8.0, 10.0), (22.0, 40.0), (32.0, 36.0), (18.0, 6.0)]
            .map(|(y, x)| PointF::from_yx(y, x));
        let (width, data) = recognition_input(&image, quad);
        assert_eq!(width, REC_MIN_WIDTH);
        let plane = REC_HEIGHT * width;
        assert_eq!((data[0], data[2 * plane]), (-1.0, 1.0));
        assert_eq!((data[135], data[2 * plane + 135]), (1.0, -1.0));
        assert_eq!((data[width - 1], data[2 * plane + width - 1]), (0.0, 0.0));
    }
}
