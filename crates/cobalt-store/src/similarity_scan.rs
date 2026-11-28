use crate::{SimilarityKind, calibrated_similarity};

pub(crate) fn raw_floor(model: &str, threshold: f64) -> f64 {
    // Calibration is monotone. Return a lower bound even at a rounding boundary.
    let (mut low, mut high) = (-1.0, 1.0);
    for _ in 0..32 {
        let mid = (low + high) * 0.5;
        if calibrated_similarity(model, SimilarityKind::Document, mid) >= threshold {
            high = mid;
        } else {
            low = mid;
        }
    }
    low
}

pub(crate) fn rounding_margin(dimensions: usize) -> f64 {
    // By Cauchy-Schwarz the sum of absolute products of unit vectors is at most
    // one. Allow for normalization and both f32 accumulation orders, including
    // SQLite's f32 squared norms and distance conversion.
    16.0 * f64::from(f32::EPSILON) * (dimensions as f64 + 1.0)
}

pub(crate) struct UnitVector {
    values: Vec<f32>,
    tail_norm: f32,
    strongest: usize,
}

impl UnitVector {
    pub(crate) fn new(vector: &[f32]) -> Self {
        let norm = vector
            .iter()
            .map(|&x| f64::from(x).powi(2))
            .sum::<f64>()
            .sqrt();
        let values: Vec<_> = vector
            .iter()
            .map(|&x| (f64::from(x) / norm) as f32)
            .collect();
        let tail_norm = values[Self::split(values.len())..]
            .iter()
            .map(|value| value * value)
            .sum::<f32>()
            .sqrt();
        let strongest = values
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| a.abs().total_cmp(&b.abs()))
            .map_or(0, |(i, _)| i);
        Self {
            values,
            tail_norm,
            strongest,
        }
    }

    fn split(dimensions: usize) -> usize {
        (dimensions / 4) & !7
    }

    #[inline]
    pub(crate) fn strongest(&self) -> usize {
        self.strongest
    }

    pub(crate) fn coordinate(&self, dimension: usize) -> Option<f32> {
        self.values.get(dimension).copied()
    }

    #[inline]
    pub(crate) fn projected_distance_squared(&self, other: &Self) -> f64 {
        // The strongest coordinates give a lower bound on squared Euclidean distance.
        let delta = self.values[self.strongest] - other.values[self.strongest];
        let mut squared = delta * delta;
        if self.strongest != other.strongest {
            let delta = self.values[other.strongest] - other.values[other.strongest];
            squared += delta * delta;
        }
        f64::from(squared)
    }

    #[inline]
    pub(crate) fn could_reach(&self, other: &Self, floor: f64) -> bool {
        if self.values.is_empty() || self.values.len() != other.values.len() {
            return true;
        }
        if self.projected_distance_squared(other) > 2.0 * (1.0 - floor) {
            return false;
        }
        let split = Self::split(self.values.len());
        let prefix = dot(&self.values[..split], &other.values[..split]);
        // Cauchy-Schwarz bounds the entire tail using the two cached tail norms.
        // Keep unordered scores from legacy invalid vectors for exact scoring.
        if f64::from(prefix + self.tail_norm * other.tail_norm) < floor {
            return false;
        }
        f64::from(prefix + dot(&self.values[split..], &other.values[split..])).partial_cmp(&floor)
            != Some(std::cmp::Ordering::Less)
    }
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    // Independent accumulators let the compiler vectorize without reassociation.
    let (a, a_tail) = a.as_chunks::<8>();
    let (b, b_tail) = b.as_chunks::<8>();
    let mut sums = [0.0; 8];
    for (a, b) in a.iter().zip(b) {
        for ((sum, a), b) in sums.iter_mut().zip(a).zip(b) {
            *sum += a * b;
        }
    }
    sums.into_iter().sum::<f32>() + a_tail.iter().zip(b_tail).map(|(a, b)| a * b).sum::<f32>()
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
#[target_feature(enable = "avx,fma")]
unsafe fn dot_avx(a: &[f32], b: &[f32]) -> f32 {
    #[cfg(target_arch = "x86")]
    use std::arch::x86::*;
    #[cfg(target_arch = "x86_64")]
    use std::arch::x86_64::*;

    let (a, a_tail) = a.as_chunks::<32>();
    let (b, b_tail) = b.as_chunks::<32>();
    let mut sums = [_mm256_setzero_ps(); 4];
    for (a, b) in a.iter().zip(b) {
        for (lane, sum) in sums.iter_mut().enumerate() {
            // SAFETY: each unaligned eight-element load fits in its 32-element chunk.
            let (a, b) = unsafe {
                (
                    _mm256_loadu_ps(a.as_ptr().add(lane * 8)),
                    _mm256_loadu_ps(b.as_ptr().add(lane * 8)),
                )
            };
            *sum = _mm256_fmadd_ps(a, b, *sum);
        }
    }
    let sum = _mm256_add_ps(
        _mm256_add_ps(sums[0], sums[1]),
        _mm256_add_ps(sums[2], sums[3]),
    );
    let mut lanes = [0.0; 8];
    // SAFETY: lanes provides space for the full register.
    unsafe { _mm256_storeu_ps(lanes.as_mut_ptr(), sum) };
    lanes.into_iter().sum::<f32>() + dot(a_tail, b_tail)
}

pub(crate) struct DotProduct {
    dot: unsafe fn(&[f32], &[f32]) -> f32,
}

impl DotProduct {
    pub(crate) fn new() -> Self {
        #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
        if std::arch::is_x86_feature_detected!("avx") && std::arch::is_x86_feature_detected!("fma")
        {
            return Self { dot: dot_avx };
        }
        Self { dot }
    }

    #[inline]
    pub(crate) fn score(&self, a: &UnitVector, b: &UnitVector) -> f64 {
        // SAFETY: new selects an accelerated implementation only on supported CPUs.
        f64::from(unsafe { (self.dot)(&a.values, &b.values) })
    }
}
