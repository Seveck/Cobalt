use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::Arc;

use cobalt_core::config::AppSettings;
use cobalt_core::enums::{MemoryCategory, MemoryStatus, PastLifeSource, SourceType, WriteAction};
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::ids::Id;
use cobalt_core::memoryignore::MemoryIgnore;
use cobalt_core::model::{GraphQuery, Memory, MemoryPatch, NewMemory, NewSourceDocument};
use cobalt_core::scrubber::scrub;
use cobalt_core::traits::{ProgressSink, TokenCounter};
use cobalt_core::transfer::{
    IngestIssue, IngestProgress, IngestReport, IngestRequest, PromoteFileRequest,
};
use sha2::{Digest, Sha256};

use crate::jobs::{Cancellation, Progress, emit_progress};
use crate::{Context, blocking, past_life};

pub(crate) const INGEST_CLIENT: &str = "cobalt-ingest";
const PAST_LIFE_CLIENT: &str = "cobalt-past-life";
pub(crate) const MAX_DOCUMENT_BYTES: u64 = 128 * 1024 * 1024;
const MAX_FOLDER_FILE_BYTES: u64 = 2 * 1024 * 1024;
const SNIFF_BYTES: usize = 8 * 1024;

pub(crate) fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub(crate) fn path_string(path: &Path) -> Result<String> {
    let path = path
        .to_str()
        .ok_or_else(|| CobaltError::InvalidInput("file path must be Unicode".into()))?;
    if scrub(path).count() != 0 {
        return Err(CobaltError::Sandbox(
            "source path contains redacted information".into(),
        ));
    }
    Ok(path.to_owned())
}

pub(crate) fn issue(path: &Path, error: CobaltError) -> IngestIssue {
    IngestIssue {
        path: scrub(&path.to_string_lossy()).text,
        message: scrub(&error.to_string()).text,
    }
}

// Binary search on character boundaries for an overlapping suffix.
fn overlap_start(counter: &dyn TokenCounter, text: &str, max: usize) -> usize {
    if max == 0 {
        return text.len();
    }
    let mut low = 0;
    let mut high = text.len();
    while low < high {
        let mut middle = low + (high - low) / 2;
        while !text.is_char_boundary(middle) {
            middle += 1;
        }
        if middle == high {
            break;
        }
        if counter.count(&text[middle..]) <= max {
            high = middle;
        } else {
            low = middle + text[middle..].chars().next().map_or(1, char::len_utf8);
        }
    }
    high
}

pub(crate) fn chunks(
    counter: &dyn TokenCounter,
    mut text: &str,
    max: usize,
    overlap: usize,
    cancellation: &Cancellation,
) -> Result<Vec<String>> {
    if max == 0 {
        return Err(CobaltError::InvalidInput(
            "maximum chunk size is zero".into(),
        ));
    }
    let mut result = Vec::new();
    text = text.trim();
    while !text.is_empty() {
        cancellation.check()?;
        let mut window = text.len().min(max.saturating_mul(32));
        while !text.is_char_boundary(window) {
            window -= 1;
        }
        let window = &text[..window];
        let prefix = counter.truncate(window, max);
        let mut end = prefix.len();
        if end == 0 || !text.starts_with(&prefix) {
            return Err(CobaltError::InvalidInput(
                "chunk size cannot fit the next character".into(),
            ));
        }
        if end < text.len()
            && let Some(boundary) = prefix.rfind('\n')
            && boundary > end / 2
        {
            end = boundary + 1;
        }
        let chunk = text[..end].trim();
        if !chunk.is_empty() {
            result.push(chunk.to_owned());
        }
        if end == text.len() {
            break;
        }
        let start = overlap_start(counter, &text[..end], overlap.min(max - 1));
        text = text[if start == 0 { end } else { start }..].trim_start();
    }
    Ok(result)
}

#[derive(Default)]
struct IgnoreMatchers {
    roots: HashMap<PathBuf, MemoryIgnore>,
    nested: HashMap<PathBuf, Option<MemoryIgnore>>,
}

impl IgnoreMatchers {
    fn ignored(
        &mut self,
        path: &Path,
        is_dir: bool,
        project_root: Option<&Path>,
        global: Option<&Path>,
    ) -> Result<bool> {
        let mut ancestors: Vec<_> = path.ancestors().skip(1).collect();
        ancestors.reverse();
        let default_root = ancestors.first().copied().unwrap_or(path);
        let root = project_root
            .filter(|root| path.starts_with(root))
            .unwrap_or(default_root);
        if !self.roots.contains_key(root) {
            self.roots
                .insert(root.to_owned(), MemoryIgnore::for_root(root, global)?);
        }
        if self.roots[root].is_ignored(path, is_dir) {
            return Ok(true);
        }
        for ancestor in ancestors {
            if ancestor == root || !ancestor.starts_with(root) {
                continue;
            }
            if !self.nested.contains_key(ancestor) {
                let matcher = ancestor
                    .join(cobalt_core::paths::MEMORY_IGNORE_FILE)
                    .is_file()
                    .then(|| MemoryIgnore::for_root(ancestor, None))
                    .transpose()?;
                self.nested.insert(ancestor.to_owned(), matcher);
            }
            if self.nested[ancestor]
                .as_ref()
                .is_some_and(|matcher| matcher.is_ignored(path, is_dir))
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

pub(crate) fn ignored(
    path: &Path,
    is_dir: bool,
    project_root: Option<&Path>,
    global: Option<&Path>,
) -> Result<bool> {
    IgnoreMatchers::default().ignored(path, is_dir, project_root, global)
}

#[derive(Default)]
struct Paths {
    files: BTreeMap<PathBuf, bool>,
    directories: BTreeSet<PathBuf>,
    issues: Vec<IngestIssue>,
    skipped: u64,
}

fn collect(
    paths: Vec<String>,
    root: Option<&Path>,
    global: Option<&Path>,
    run: &IngestRun,
) -> Paths {
    let source = run.source;
    let mut result = Paths::default();
    let mut pending: Vec<_> = paths
        .into_iter()
        .map(|path| (PathBuf::from(path), true))
        .collect();
    let mut visited_directories = HashSet::new();
    let mut visited_skips = HashSet::new();
    let mut ignores = IgnoreMatchers::default();
    while let Some((path, direct)) = pending.pop() {
        if run.cancellation.check().is_err() {
            break;
        }
        let explicit = direct && !run.folder_limited;
        let visit = (|| {
            let absolute = std::path::absolute(&path)?;
            let metadata = absolute.symlink_metadata()?;
            if metadata.is_symlink() {
                result.skipped += u64::from(visited_skips.insert(absolute));
                return Ok(());
            }
            let candidate = metadata.is_file() && (explicit || eligible(&absolute, source));
            let conversations_zip = candidate && is_conversations_zip(&absolute, source);
            let known_binary = candidate && !conversations_zip && binary_extension(&absolute);
            if !known_binary && ignores.ignored(&absolute, metadata.is_dir(), root, global)? {
                result.skipped += u64::from(visited_skips.insert(absolute));
                return Ok(());
            }
            let path = absolute.canonicalize()?;
            if !known_binary && ignores.ignored(&path, metadata.is_dir(), root, global)? {
                result.skipped += u64::from(visited_skips.insert(path));
                return Ok(());
            }
            path_string(&path)?;
            if metadata.is_dir() {
                if direct && source.is_none() {
                    result.directories.insert(path.clone());
                }
                if !visited_directories.insert(path.clone()) {
                    return Ok(());
                }
                let discovered = (result.files.len() + result.directories.len()) as u64;
                run.progress.document(&path, 0, discovered, "scanning");
                for entry in std::fs::read_dir(&path)? {
                    run.cancellation.check()?;
                    match entry {
                        Ok(entry) => pending.push((entry.path(), false)),
                        Err(error) => result.issues.push(issue(&path, error.into())),
                    }
                }
            } else if candidate {
                // Prefer the explicit-file limit when the same file was also reached by a walk.
                *result.files.entry(path).or_insert(false) |= explicit;
            }
            Ok(())
        })();
        match visit {
            Err(CobaltError::Cancelled) => break,
            Err(error) => result.issues.push(issue(&path, error)),
            Ok(()) => {}
        }
    }
    result
}

fn is_conversations_zip(path: &Path, source: Option<PastLifeSource>) -> bool {
    matches!(
        source,
        Some(PastLifeSource::ChatgptExport | PastLifeSource::ClaudeExport)
    ) && path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
}

fn binary_extension(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some(
            "a" | "o"
                | "obj"
                | "lib"
                | "so"
                | "dll"
                | "dylib"
                | "exe"
                | "bin"
                | "class"
                | "jar"
                | "war"
                | "wasm"
                | "pyc"
                | "pyo"
                | "pack"
                | "db"
                | "sqlite"
                | "sqlite3"
                | "onnx"
                | "pt"
                | "pth"
                | "safetensors"
                | "parquet"
                | "zip"
                | "tar"
                | "gz"
                | "tgz"
                | "bz2"
                | "xz"
                | "zst"
                | "7z"
                | "rar"
                | "iso"
                | "mp4"
                | "mov"
                | "mkv"
                | "avi"
                | "webm"
                | "mp3"
                | "wav"
                | "ogg"
                | "flac"
                | "ico"
                | "woff"
                | "woff2"
                | "ttf"
                | "otf"
                | "psd"
                | "docx"
                | "xlsx"
                | "pptx"
        )
    )
}

pub(crate) fn eligible(path: &Path, source: Option<PastLifeSource>) -> bool {
    let name = path.file_name().and_then(|name| name.to_str());
    let kind = SourceType::from_path(path);
    match source {
        Some(PastLifeSource::ChatgptExport | PastLifeSource::ClaudeExport) => {
            name == Some("conversations.json")
        }
        Some(PastLifeSource::CursorRules) => name == Some(".cursorrules"),
        Some(PastLifeSource::ClaudeMd) => name == Some("CLAUDE.md"),
        Some(PastLifeSource::MarkdownFolder) => kind == SourceType::Md,
        None => name != Some(cobalt_core::paths::MEMORY_IGNORE_FILE),
    }
}

pub(crate) fn read_document(mut input: impl Read) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    input
        .by_ref()
        .take(MAX_DOCUMENT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err(CobaltError::InvalidInput(
            "document exceeds the ingestion size limit".into(),
        ));
    }
    Ok(bytes)
}

pub(crate) enum FileRead {
    Bytes(Vec<u8>),
    Skipped(CobaltError),
}

impl FileRead {
    fn unsupported(reason: &str) -> Self {
        Self::Skipped(CobaltError::Unsupported(reason.into()))
    }

    fn over_limit(limit: u64) -> Self {
        let reason = if limit == MAX_FOLDER_FILE_BYTES {
            "document exceeds the 2 MiB folder ingestion limit"
        } else {
            "document exceeds the 128 MiB ingestion limit"
        };
        Self::Skipped(CobaltError::InvalidInput(reason.into()))
    }
}

pub(crate) fn read_text_document(mut input: impl Read, limit: u64) -> Result<FileRead> {
    let mut input = input.by_ref().take(limit + 1);
    let mut bytes = Vec::with_capacity(SNIFF_BYTES);
    input
        .by_ref()
        .take(SNIFF_BYTES as u64)
        .read_to_end(&mut bytes)?;
    if bytes.contains(&0) {
        return Ok(FileRead::unsupported("binary document contains a NUL byte"));
    }
    if let Err(error) = std::str::from_utf8(&bytes)
        && (error.error_len().is_some() || bytes.len() < SNIFF_BYTES)
    {
        return Ok(FileRead::unsupported("document is not UTF-8 text"));
    }
    input.read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Ok(FileRead::over_limit(limit));
    }
    if bytes[SNIFF_BYTES.min(bytes.len())..].contains(&0) {
        return Ok(FileRead::unsupported("binary document contains a NUL byte"));
    }
    // Validate the complete text too, including a code point split at the sniff boundary.
    if std::str::from_utf8(&bytes).is_err() {
        return Ok(FileRead::unsupported("document is not UTF-8 text"));
    }
    Ok(FileRead::Bytes(bytes))
}

fn read_file(
    path: &Path,
    kind: SourceType,
    explicit: bool,
    conversations_zip: bool,
    ocr: bool,
) -> Result<FileRead> {
    if !explicit && matches!(kind, SourceType::Pdf | SourceType::Image)
        || !conversations_zip && binary_extension(path)
    {
        return Ok(FileRead::unsupported(
            "binary document excluded by file extension",
        ));
    }
    if kind == SourceType::Image {
        return Ok(FileRead::Skipped(ocr_error(ocr)));
    }
    let limit = if explicit {
        MAX_DOCUMENT_BYTES
    } else {
        MAX_FOLDER_FILE_BYTES
    };
    if path.metadata()?.len() > limit {
        return Ok(FileRead::over_limit(limit));
    }
    let file = std::fs::File::open(path)?;
    if conversations_zip || kind == SourceType::Pdf {
        return read_document(file).map(FileRead::Bytes);
    }
    read_text_document(file, limit)
}

fn ocr_error(ocr: bool) -> CobaltError {
    CobaltError::Unsupported(if ocr {
        "OCR requires catalog-verified ocrs detection and recognition models, which are unavailable"
            .into()
    } else {
        "this document requires OCR, which is disabled for this import".into()
    })
}

fn text_from_bytes(bytes: &[u8], kind: SourceType, ocr: bool) -> Result<String> {
    match kind {
        SourceType::Image => Err(ocr_error(ocr)),
        SourceType::Pdf => {
            let pdf = lopdf::Document::load_mem(bytes)
                .map_err(|err| CobaltError::InvalidInput(format!("invalid PDF: {err}")))?;
            let pages: Vec<_> = pdf.get_pages().into_keys().collect();
            let text = pdf.extract_text(&pages).map_err(|err| {
                CobaltError::InvalidInput(format!("cannot extract PDF text: {err}"))
            })?;
            if text.trim().is_empty() {
                Err(ocr_error(ocr))
            } else {
                Ok(text)
            }
        }
        _ => {
            let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
            if bytes.contains(&0) {
                return Err(CobaltError::Unsupported("binary document".into()));
            }
            std::str::from_utf8(bytes)
                .map(str::to_owned)
                .map_err(|_| CobaltError::Unsupported("document is not UTF-8 text".into()))
        }
    }
}

fn category(kind: SourceType) -> MemoryCategory {
    match kind {
        SourceType::Note => MemoryCategory::Note,
        SourceType::Image => MemoryCategory::Ocr,
        SourceType::Md | SourceType::Pdf | SourceType::Other => MemoryCategory::Doc,
        _ => MemoryCategory::Code,
    }
}

fn chunk_limit(settings: &AppSettings) -> usize {
    settings
        .chunking
        .max_chunk_tokens
        .min(settings.firewall.max_tokens_per_memory) as usize
}

fn check_document_text(content: &str) -> Result<()> {
    if cobalt_core::firewall::looks_like_log_dump(content) {
        return Err(CobaltError::FirewallBlocked(
            "raw logs and stack traces require an atomic summary".into(),
        ));
    }
    Ok(())
}

struct FileInput {
    path: String,
    project_id: Option<Id>,
    branch: Id,
    kind: SourceType,
    reusable: bool,
    client: &'static str,
    file_hash: String,
    total_tokens: usize,
    redactions: u64,
    contents: Vec<(MemoryCategory, String)>,
}

#[derive(Default)]
struct IngestRun {
    cancellation: Cancellation,
    folder_limited: bool,
    from_watcher: bool,
    source: Option<PastLifeSource>,
    progress: Progress,
}

struct DocumentWork<'a> {
    req: &'a IngestRequest,
    settings: &'a AppSettings,
    branch: Id,
    run: &'a IngestRun,
}

impl Context {
    pub(crate) async fn ingest(
        &self,
        req: IngestRequest,
        source: Option<PastLifeSource>,
        progress: ProgressSink<IngestProgress>,
    ) -> Result<IngestReport> {
        let job = self.jobs.start();
        let (updates, receiver) = Progress::channel(job.id, req.paths.first().map(String::as_str));
        let ((), report) = tokio::join!(emit_progress(receiver, progress), async {
            let report = self
                .ingest_job(
                    req,
                    IngestRun {
                        cancellation: job.cancellation.clone(),
                        source,
                        progress: updates,
                        ..Default::default()
                    },
                )
                .await;
            drop(job);
            report
        });
        report
    }

    pub(crate) async fn ingest_watched(
        &self,
        req: IngestRequest,
        folder_limited: bool,
        cancellation: &Cancellation,
    ) -> Result<IngestReport> {
        self.ingest_job(
            req,
            IngestRun {
                cancellation: cancellation.clone(),
                from_watcher: true,
                folder_limited,
                ..Default::default()
            },
        )
        .await
    }

    async fn ingest_job(&self, req: IngestRequest, run: IngestRun) -> Result<IngestReport> {
        let _write = tokio::select! {
            biased;
            _ = run.cancellation.cancelled() => return Ok(IngestReport::default()),
            guard = self.writes.lock() => guard,
        };
        let root = if let Some(id) = req.project_id {
            self.store
                .get_project(id)
                .await?
                .ok_or_else(|| CobaltError::NotFound(format!("project {id}")))?
                .root_path
                .map(PathBuf::from)
        } else {
            None
        };
        let global = self.global_ignore.clone();
        let paths = req.paths.clone();
        let scan = IngestRun {
            cancellation: run.cancellation.clone(),
            progress: run.progress.clone(),
            ..run
        };
        let Paths {
            files,
            directories,
            skipped,
            issues,
        } = blocking(move || Ok(collect(paths, root.as_deref(), global.as_deref(), &scan))).await?;
        let mut report = IngestReport {
            skipped_ignored: skipped,
            errors: issues,
            ..Default::default()
        };
        let total = (files.len() + directories.len()) as u64;
        if run.cancellation.check().is_err() {
            run.progress.finish(0, total);
            return Ok(report);
        }
        let settings = self.store.load_settings().await?;
        if settings.read_only {
            return Err(CobaltError::ReadOnly);
        }
        let work = DocumentWork {
            req: &req,
            settings: &settings,
            branch: self.store.active_branch().await?.id,
            run: &run,
        };
        let mut pending_watches = Vec::new();
        let mut processed = 0;
        for (path, file) in directories.into_iter().map(|path| (path, None)).chain(
            files
                .into_iter()
                .map(|(path, explicit)| (path, Some(explicit))),
        ) {
            if run.cancellation.check().is_err() {
                break;
            }
            run.progress.document(
                &path,
                processed,
                total,
                if file.is_some() { "reading" } else { "saving" },
            );
            let result = if run.from_watcher
                && self
                    .store
                    .find_source_document_by_path(&path_string(&path)?)
                    .await?
                    .is_some_and(|doc| !doc.is_watched)
            {
                Ok(None)
            } else if let Some(explicit) = file {
                self.process_file(&path, explicit, &work, &mut report).await
            } else {
                self.register_directory(&path, &req, &mut report).await
            };
            match result {
                Ok(Some(id)) if req.watch => pending_watches.push((id, path)),
                Err(CobaltError::Cancelled) if run.cancellation.check().is_err() => break,
                Err(error) => report.errors.push(issue(&path, error)),
                Ok(_) => {}
            }
            processed += 1;
        }
        if !pending_watches.is_empty() && run.cancellation.check().is_ok() {
            run.progress.stage("saving");
        }
        self.enroll_watches(pending_watches, &run, &mut report)
            .await;
        run.progress.finish(processed, total);
        Ok(report)
    }

    async fn enroll_watches(
        &self,
        pending: Vec<(Id, PathBuf)>,
        run: &IngestRun,
        report: &mut IngestReport,
    ) {
        let mut enrolled = Vec::new();
        for (id, path) in pending {
            if run.cancellation.check().is_err() {
                break;
            }
            match self.store.set_watched(id, true).await {
                Ok(_) => enrolled.push((id, path)),
                Err(error) => report.errors.push(issue(&path, error)),
            }
        }
        if run.cancellation.check().is_err() {
            for (id, path) in enrolled {
                if let Err(error) = self.store.set_watched(id, false).await {
                    report.errors.push(issue(&path, error));
                }
            }
        }
    }

    async fn register_directory(
        &self,
        path: &Path,
        req: &IngestRequest,
        report: &mut IngestReport,
    ) -> Result<Option<Id>> {
        let file_path = path_string(path)?;
        let prior = self.store.find_source_document_by_path(&file_path).await?;
        if let Some(prior) = &prior
            && prior.is_dir
            && prior.project_id == req.project_id
        {
            if req.watch && !prior.is_watched {
                report.documents_updated += 1;
            } else {
                report.documents_unchanged += 1;
            }
            return Ok((!prior.is_watched).then_some(prior.id));
        }
        let doc = self
            .store
            .upsert_source_document(NewSourceDocument {
                project_id: req.project_id,
                file_path,
                is_dir: true,
                source_type: Some(SourceType::Other),
                file_hash: None,
                total_tokens: 0,
                is_watched: prior.as_ref().is_some_and(|doc| doc.is_watched),
            })
            .await?;
        if prior.is_some() {
            report.documents_updated += 1;
        } else {
            report.documents_created += 1;
        }
        Ok((!doc.is_watched).then_some(doc.id))
    }

    async fn process_file(
        &self,
        path: &Path,
        explicit: bool,
        work: &DocumentWork<'_>,
        report: &mut IngestReport,
    ) -> Result<Option<Id>> {
        let file_path = path_string(path)?;
        let read_path = path.to_owned();
        let source = work.run.source;
        let client = if source.is_some() {
            PAST_LIFE_CLIENT
        } else {
            INGEST_CLIENT
        };
        let conversations_zip = is_conversations_zip(path, source);
        let kind = if conversations_zip {
            SourceType::Json
        } else {
            SourceType::from_path(path)
        };
        let tokens = self.tokens.clone();
        let max = chunk_limit(work.settings);
        let overlap = work.settings.chunking.overlap_tokens as usize;
        let ocr = work.req.ocr;
        let cancellation = work.run.cancellation.clone();
        let prepared = blocking(move || {
            cancellation.check()?;
            let bytes = match read_file(&read_path, kind, explicit, conversations_zip, ocr)? {
                FileRead::Bytes(bytes) => bytes,
                FileRead::Skipped(error) => return Ok(Err(error)),
            };
            cancellation.check()?;
            let file_hash = digest(&bytes);
            let text = if conversations_zip {
                let json = past_life::conversations_from_zip(&bytes)?;
                text_from_bytes(&json, kind, ocr)?
            } else {
                text_from_bytes(&bytes, kind, ocr)?
            };
            cancellation.check()?;
            let total = tokens.count(&text);
            cancellation.check()?;
            let messages = match source {
                Some(source) => past_life::messages(source, &text)?,
                None => vec![text],
            };
            let mut redactions = 0;
            let mut contents = Vec::new();
            for message in messages {
                cancellation.check()?;
                let clean = scrub(&message);
                redactions += u64::from(clean.count());
                check_document_text(&clean.text)?;
                if let Some(source) = source {
                    for (category, atom) in past_life::distill(source, &clean.text) {
                        contents.extend(
                            chunks(tokens.as_ref(), &atom, max, 0, &cancellation)?
                                .into_iter()
                                .map(|chunk| (category, chunk)),
                        );
                    }
                } else {
                    contents.extend(
                        chunks(tokens.as_ref(), &clean.text, max, overlap, &cancellation)?
                            .into_iter()
                            .map(|chunk| (category(kind), chunk)),
                    );
                }
            }
            Ok(Ok((file_hash, total, redactions, contents)))
        });
        let result = tokio::select! {
            biased;
            _ = work.run.cancellation.cancelled() => return Err(CobaltError::Cancelled),
            result = prepared => result?,
        };
        let (file_hash, total_tokens, redactions, contents) = match result {
            Ok(prepared) => prepared,
            Err(error) => {
                report.skipped_ignored += 1;
                report.errors.push(issue(path, error));
                return Ok(None);
            }
        };
        self.persist_file(
            FileInput {
                path: file_path,
                project_id: work.req.project_id,
                branch: work.branch,
                kind,
                reusable: work.req.mark_reusable,
                client,
                file_hash,
                total_tokens,
                redactions,
                contents,
            },
            work.run,
            report,
        )
        .await
    }

    async fn persist_file(
        &self,
        input: FileInput,
        run: &IngestRun,
        report: &mut IngestReport,
    ) -> Result<Option<Id>> {
        run.cancellation.check()?;
        run.progress.stage("saving");
        if input.contents.is_empty() && input.client == PAST_LIFE_CLIENT {
            return Err(CobaltError::InvalidInput(
                "no atomic memories identified in this document".into(),
            ));
        }
        let prior = self.store.find_source_document_by_path(&input.path).await?;
        let total_tokens = i64::try_from(input.total_tokens)
            .map_err(|_| CobaltError::InvalidInput("file token count is too large".into()))?;
        let mut doc = NewSourceDocument {
            project_id: input.project_id,
            file_path: input.path,
            is_dir: false,
            source_type: Some(input.kind),
            file_hash: Some(input.file_hash),
            total_tokens,
            is_watched: prior.as_ref().is_some_and(|doc| doc.is_watched),
        };
        let doc_id = if let Some(prior) = &prior {
            prior.id
        } else {
            self.store
                .upsert_source_document(NewSourceDocument {
                    file_hash: None,
                    ..doc.clone()
                })
                .await?
                .id
        };
        let graph = if let Some(store) = &self.sqlite {
            store
                .ingested_memories(input.branch, doc_id, input.client)
                .await?
        } else {
            let mut rows = Vec::new();
            for node in self
                .store
                .graph(GraphQuery {
                    branch_id: Some(input.branch),
                    ..Default::default()
                })
                .await?
                .nodes
            {
                if node.source_doc_id == Some(doc_id)
                    && let Some(memory) = self.store.get_memory(node.id).await?
                    && memory.source_client.as_deref() == Some(input.client)
                {
                    rows.push(memory);
                }
            }
            rows
        };
        let mut old: HashMap<_, _> = graph
            .into_iter()
            .map(|row| (row.content_hash.clone(), row))
            .collect();
        let mut seen = HashSet::new();
        let chunks: Vec<_> = input
            .contents
            .into_iter()
            .filter_map(|(category, content)| {
                let hash = digest(content.as_bytes());
                seen.insert(hash.clone())
                    .then_some((hash, category, content))
            })
            .collect();
        if let Some(prior) = &prior
            && prior.file_hash == doc.file_hash
            && prior.project_id == doc.project_id
            && prior.total_tokens == doc.total_tokens
            && chunks.len() == old.len()
            && chunks.iter().all(|(hash, _, _)| {
                old.get(hash).is_some_and(|row| {
                    row.project_id == doc.project_id
                        && (!input.reusable || (row.is_reusable && row.reusable_snippet.is_some()))
                })
            })
        {
            run.cancellation.check()?;
            report.documents_unchanged += 1;
            return Ok((!doc.is_watched).then_some(doc_id));
        }
        for (hash, category, content) in chunks {
            run.cancellation.check()?;
            let snippet = input.reusable.then(|| {
                self.tokens
                    .truncate(&content, cobalt_core::mcp::REUSABLE_SUMMARY_TOKENS as usize)
            });
            if let Some(row) = old.get(&hash)
                && row.project_id == input.project_id
            {
                if input.reusable
                    && !row.is_encrypted
                    && (!row.is_reusable || row.reusable_snippet.is_none())
                {
                    self.store
                        .patch_memory(
                            row.id,
                            MemoryPatch {
                                is_reusable: Some(true),
                                reusable_snippet: Some(snippet),
                                ..Default::default()
                            },
                        )
                        .await?;
                }
                old.remove(&hash);
                continue;
            }
            let new = NewMemory {
                content,
                category,
                project_id: input.project_id,
                branch_id: Some(input.branch),
                source_doc_id: Some(doc_id),
                source_type: Some(input.kind),
                confidence: None,
                is_core_pin: false,
                is_reusable: input.reusable,
                reusable_snippet: snippet,
                source_client: Some(input.client.into()),
            };
            run.progress.stage("embedding");
            // Each store call embeds and writes one chunk. Let the current write finish.
            let action = if let Some(store) = &self.sqlite {
                store.insert_document_chunk(new).await?.action
            } else {
                self.store.save_memory(new).await?.action
            };
            report.memories_created += u64::from(matches!(
                action,
                WriteAction::Inserted | WriteAction::Superseded
            ));
            report.memories_superseded += u64::from(action == WriteAction::Superseded);
        }
        run.cancellation.check()?;
        run.progress.stage("saving");
        for row in old
            .into_values()
            .filter(|row| !row.is_core_pin && !row.is_encrypted)
        {
            if row.status == MemoryStatus::Active {
                self.store
                    .archive_memory(row.id, "Source document changed")
                    .await?;
            }
        }
        // A publishable hash marks the complete reconciliation. Preserve the watch flag when a
        // newly discovered file is already registered by the time processing finishes.
        doc.is_watched |= self
            .store
            .get_source_document(doc_id)
            .await?
            .is_some_and(|row| row.is_watched);
        let doc = self.store.upsert_source_document(doc).await?;
        report.total_tokens += input.total_tokens as u64;
        report.redacted_secrets += input.redactions;
        if prior.as_ref().is_some_and(|doc| doc.file_hash.is_some()) {
            report.documents_updated += 1;
        } else {
            report.documents_created += 1;
        }
        Ok((!doc.is_watched).then_some(doc_id))
    }

    pub(crate) async fn promote(&self, req: PromoteFileRequest) -> Result<Memory> {
        let _write = self.writes.lock().await;
        let root = match req.project_id {
            Some(id) => {
                self.store
                    .get_project(id)
                    .await?
                    .ok_or_else(|| CobaltError::NotFound(format!("project {id}")))?
                    .root_path
            }
            None => None,
        };
        let global = self.global_ignore.clone();
        let path = req.path;
        let settings = self.store.load_settings().await?;
        if settings.read_only {
            return Err(CobaltError::ReadOnly);
        }
        let limit = chunk_limit(&settings).min(cobalt_core::mcp::REUSABLE_SUMMARY_TOKENS as usize);
        let tokens = self.tokens.clone();
        let summary = req.summary;
        let (path, kind, hash, total_tokens, snippet) = blocking(move || {
            let input = std::path::absolute(path)?;
            if input.symlink_metadata()?.is_symlink()
                || ignored(
                    &input,
                    false,
                    root.as_deref().map(Path::new),
                    global.as_deref(),
                )?
            {
                return Err(CobaltError::Sandbox(
                    "file is excluded from ingestion".into(),
                ));
            }
            let path = input.canonicalize()?;
            if !path.is_file()
                || ignored(
                    &path,
                    false,
                    root.as_deref().map(Path::new),
                    global.as_deref(),
                )?
            {
                return Err(CobaltError::Sandbox(
                    "file is excluded from ingestion".into(),
                ));
            }
            let bytes = read_document(std::fs::File::open(&path)?)?;
            let kind = SourceType::from_path(&path);
            let text = text_from_bytes(&bytes, kind, true)?;
            let clean = scrub(summary.as_deref().unwrap_or(&text));
            check_document_text(&clean.text)?;
            let snippet = tokens.truncate(clean.text.trim(), limit);
            if snippet.trim().is_empty() {
                return Err(CobaltError::InvalidInput(
                    "reusable snippet is empty".into(),
                ));
            }
            let total_tokens = i64::try_from(tokens.count(&text))
                .map_err(|_| CobaltError::InvalidInput("file token count is too large".into()))?;
            Ok((
                path_string(&path)?,
                kind,
                digest(&bytes),
                total_tokens,
                snippet,
            ))
        })
        .await?;
        let old = self.store.find_source_document_by_path(&path).await?;
        let doc = match old {
            Some(doc) => doc,
            None => {
                self.store
                    .upsert_source_document(NewSourceDocument {
                        project_id: req.project_id,
                        file_path: path,
                        is_dir: false,
                        source_type: Some(kind),
                        file_hash: Some(hash),
                        total_tokens,
                        is_watched: false,
                    })
                    .await?
            }
        };
        let new = NewMemory {
            content: snippet.clone(),
            category: category(kind),
            project_id: req.project_id,
            branch_id: Some(self.store.active_branch().await?.id),
            source_doc_id: Some(doc.id),
            source_type: Some(kind),
            confidence: None,
            is_core_pin: false,
            is_reusable: true,
            reusable_snippet: Some(snippet.clone()),
            source_client: Some("cobalt-promotion".into()),
        };
        let saved = if let Some(store) = &self.sqlite {
            store.insert_document_chunk(new).await?
        } else {
            self.store.save_memory(new).await?
        };
        if saved.action == WriteAction::Duplicate && !saved.memory.is_reusable {
            return self
                .store
                .patch_memory(
                    saved.memory.id,
                    MemoryPatch {
                        is_reusable: Some(true),
                        reusable_snippet: Some(Some(snippet)),
                        ..Default::default()
                    },
                )
                .await;
        }
        Ok(saved.memory)
    }
}

#[cfg(test)]
pub(crate) fn quiet_progress() -> ProgressSink<IngestProgress> {
    Arc::new(|_| {})
}
