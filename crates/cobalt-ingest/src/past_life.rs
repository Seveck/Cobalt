use std::io::Cursor;
use std::path::Path;

use cobalt_core::enums::{MemoryCategory, PastLifeSource};
use cobalt_core::error::{CobaltError, Result};
use serde_json::Value;

pub(crate) fn conversations_from_zip(bytes: &[u8]) -> Result<Vec<u8>> {
    let invalid_zip = |error: zip::result::ZipError| {
        CobaltError::InvalidInput(format!("invalid conversations ZIP: {error}"))
    };
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(invalid_zip)?;
    let mut name = None;
    for entry in zip.file_names() {
        let entry = entry.map_err(invalid_zip)?;
        if Path::new(entry.as_ref())
            .file_name()
            .is_some_and(|base| base == "conversations.json")
            && name.replace(entry.into_owned()).is_some()
        {
            return Err(CobaltError::InvalidInput(
                "export ZIP contains multiple conversations.json files".into(),
            ));
        }
    }
    let name =
        name.ok_or_else(|| CobaltError::NotFound("conversations.json in export ZIP".into()))?;
    crate::documents::read_document(zip.by_name(&name).map_err(invalid_zip)?)
}

pub(crate) fn messages(source: PastLifeSource, text: &str) -> Result<Vec<String>> {
    if !matches!(
        source,
        PastLifeSource::ChatgptExport | PastLifeSource::ClaudeExport
    ) {
        return Ok(vec![text.to_owned()]);
    }
    let json: Value = serde_json::from_str(text)?;
    let conversations = json
        .as_array()
        .or_else(|| json["conversations"].as_array())
        .ok_or_else(|| CobaltError::InvalidInput("expected a conversations export".into()))?;
    let mut messages = Vec::new();
    for conversation in conversations {
        match source {
            PastLifeSource::ChatgptExport => {
                let Some(mapping) = conversation["mapping"].as_object() else {
                    continue;
                };
                let mut path = Vec::new();
                let mut visited = std::collections::HashSet::new();
                let mut current = conversation["current_node"].as_str();
                while let Some(id) = current.filter(|id| visited.insert(*id)) {
                    let Some(node) = mapping.get(id) else { break };
                    path.push(node);
                    current = node["parent"].as_str();
                }
                if path.is_empty() {
                    path.extend(mapping.values().rev());
                }
                for node in path.into_iter().rev() {
                    let message = &node["message"];
                    if message["author"]["role"] == "user"
                        && let Some(parts) = message["content"]["parts"].as_array()
                    {
                        messages.push(
                            parts
                                .iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join("\n"),
                        );
                    }
                }
            }
            PastLifeSource::ClaudeExport => {
                for message in conversation["chat_messages"]
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    if !matches!(message["sender"].as_str(), Some("human" | "user")) {
                        continue;
                    }
                    if let Some(text) = message["text"]
                        .as_str()
                        .filter(|text| !text.trim().is_empty())
                    {
                        messages.push(text.to_owned());
                    } else if let Some(blocks) = message["content"].as_array() {
                        messages.push(
                            blocks
                                .iter()
                                .filter(|block| block["type"] == "text")
                                .filter_map(|block| block["text"].as_str())
                                .collect::<Vec<_>>()
                                .join("\n"),
                        );
                    }
                }
            }
            _ => {}
        }
    }
    if !messages.iter().any(|text| !text.trim().is_empty()) {
        return Err(CobaltError::InvalidInput(
            "no user messages in conversations export".into(),
        ));
    }
    Ok(messages)
}

pub(crate) fn distill(source: PastLifeSource, text: &str) -> Vec<(MemoryCategory, String)> {
    let mut result = Vec::new();
    let mut heading = "";
    let mut code = false;
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if line.starts_with("```") || line.starts_with("~~~") {
            code = !code;
            continue;
        }
        if code {
            continue;
        }
        if line.starts_with('#') {
            heading = line.trim_start_matches('#').trim();
            continue;
        }
        let numbered = line
            .split_once(". ")
            .filter(|(number, _)| {
                !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())
            })
            .map(|(_, value)| value);
        let bullet = line
            .strip_prefix("- ")
            .or_else(|| line.strip_prefix("* "))
            .or_else(|| line.strip_prefix("+ "))
            .or(numbered);
        for sentence in sentences(bullet.unwrap_or(line)) {
            let sentence = sentence.trim();
            if sentence.is_empty() || sentence.ends_with('?') {
                continue;
            }
            let lower = sentence.to_lowercase();
            let decision = [
                "decid",
                "agreed to",
                "we will ",
                "opted for",
                "chosen ",
                "going with",
                "acordamos",
                "elegimos",
                "adoptaremos",
            ]
            .iter()
            .any(|term| lower.contains(term));
            let preference = [
                "prefer", "always ", "never ", "must ", "evita ", "siempre ", "nunca ",
            ]
            .iter()
            .any(|term| lower.contains(term));
            let category = if decision {
                MemoryCategory::Decision
            } else if preference
                || matches!(
                    source,
                    PastLifeSource::CursorRules | PastLifeSource::ClaudeMd
                )
            {
                MemoryCategory::Preference
            } else if bullet.is_some()
                || (!heading.is_empty() && matches!(source, PastLifeSource::MarkdownFolder))
            {
                MemoryCategory::Doc
            } else {
                continue;
            };
            let content = if heading.is_empty() {
                sentence.to_owned()
            } else {
                format!("{heading}: {sentence}")
            };
            result.push((category, content));
        }
    }
    result
}

fn sentences(mut text: &str) -> impl Iterator<Item = &str> {
    std::iter::from_fn(move || {
        if text.is_empty() {
            return None;
        }
        let end = text
            .match_indices(['.', '!', '?'])
            .find_map(|(idx, punctuation)| {
                let end = idx + punctuation.len();
                text[end..]
                    .chars()
                    .next()
                    .is_none_or(char::is_whitespace)
                    .then_some(end)
            })
            .unwrap_or(text.len());
        let (sentence, tail) = text.split_at(end);
        text = tail.trim_start();
        Some(sentence)
    })
}
