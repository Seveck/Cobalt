//! Secret Scrubber: redacts credentials and sensitive data before anything is embedded or
//! stored. Specific pattern rules win over generic ones (email, card, entropy). Pattern rules (provider token formats, PEM blocks, JWTs, `.env` assignments,
//! emails, Luhn-valid card numbers) run first; a Shannon-entropy pass then catches unknown
//! high-entropy tokens.

use std::sync::OnceLock;

use regex::Regex;

/// Category of a redacted secret (used in the `[REDACTED:<kind>]` marker).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SecretKind {
    PrivateKey,
    OpenAiKey,
    AnthropicKey,
    GithubToken,
    AwsAccessKey,
    AwsSecretKey,
    GoogleApiKey,
    SlackToken,
    StripeKey,
    Jwt,
    EnvSecret,
    ConnectionString,
    Email,
    CreditCard,
    HighEntropy,
}

impl SecretKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PrivateKey => "private_key",
            Self::OpenAiKey => "openai_key",
            Self::AnthropicKey => "anthropic_key",
            Self::GithubToken => "github_token",
            Self::AwsAccessKey => "aws_access_key",
            Self::AwsSecretKey => "aws_secret_key",
            Self::GoogleApiKey => "google_api_key",
            Self::SlackToken => "slack_token",
            Self::StripeKey => "stripe_key",
            Self::Jwt => "jwt",
            Self::EnvSecret => "env_secret",
            Self::ConnectionString => "connection_string",
            Self::Email => "email",
            Self::CreditCard => "credit_card",
            Self::HighEntropy => "high_entropy",
        }
    }
}

/// One redaction, as a byte range of the **original** text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Redaction {
    pub kind: SecretKind,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScrubOutcome {
    pub text: String,
    pub redactions: Vec<Redaction>,
}

impl ScrubOutcome {
    pub fn count(&self) -> u32 {
        u32::try_from(self.redactions.len()).unwrap_or(u32::MAX)
    }
}

#[derive(Debug, Clone)]
pub struct ScrubberOptions {
    pub redact_emails: bool,
    /// Minimum length of a token checked by the entropy pass.
    pub entropy_min_len: usize,
    /// Minimum Shannon entropy (bits per char) to redact an unknown token.
    pub entropy_threshold: f64,
}

impl Default for ScrubberOptions {
    fn default() -> Self {
        Self {
            redact_emails: true,
            entropy_min_len: 32,
            entropy_threshold: 4.3,
        }
    }
}

struct Rule {
    kind: SecretKind,
    regex: Regex,
    /// Capture group to redact (0 = whole match).
    group: usize,
}

const RULES: &[(SecretKind, &str, usize)] = &[
    (
        SecretKind::PrivateKey,
        r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----",
        0,
    ),
    (SecretKind::AnthropicKey, r"\bsk-ant-[A-Za-z0-9_\-]{20,}", 0),
    (
        SecretKind::OpenAiKey,
        r"\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_\-]{20,}",
        0,
    ),
    (
        SecretKind::GithubToken,
        r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})",
        0,
    ),
    (
        SecretKind::AwsAccessKey,
        r"\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b",
        0,
    ),
    (
        SecretKind::AwsSecretKey,
        r#"(?i)aws_?secret_?access_?key["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})"#,
        1,
    ),
    (SecretKind::GoogleApiKey, r"\bAIza[0-9A-Za-z_\-]{35}\b", 0),
    (
        SecretKind::SlackToken,
        r"\bxox[abposr]-[A-Za-z0-9\-]{10,}",
        0,
    ),
    (
        SecretKind::StripeKey,
        r"\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}",
        0,
    ),
    (
        SecretKind::Jwt,
        r"\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}",
        0,
    ),
    (
        SecretKind::ConnectionString,
        r"\b[a-z][a-z0-9+.\-]{1,20}://[^\s:/@]+:([^\s@/]{3,})@[^\s/]+",
        1,
    ),
    (
        SecretKind::EnvSecret,
        r#"(?im)^[ \t]*(?:export[ \t]+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CLIENT_?SECRET|AUTH)[A-Z0-9_]*[ \t]*[=:][ \t]*["']?([^\s"'#]{4,})"#,
        1,
    ),
];

const EMAIL_RE: &str = r"\b[A-Za-z0-9._%+\-]+@([A-Za-z0-9\-]+\.)+[A-Za-z]{2,}\b";
const CARD_RE: &str = r"\b\d(?:[ \-]?\d){12,18}\b";
const TOKEN_RE: &str = r"[A-Za-z0-9+/=_\-]{16,}";

struct Compiled {
    rules: Vec<Rule>,
    email: Option<Regex>,
    card: Option<Regex>,
    token: Option<Regex>,
}

fn compiled() -> &'static Compiled {
    static CELL: OnceLock<Compiled> = OnceLock::new();
    CELL.get_or_init(|| {
        let rules = RULES
            .iter()
            .filter_map(|(kind, pattern, group)| match Regex::new(pattern) {
                Ok(regex) => Some(Rule {
                    kind: *kind,
                    regex,
                    group: *group,
                }),
                Err(err) => {
                    tracing::error!(kind = kind.as_str(), %err, "invalid scrubber pattern");
                    None
                }
            })
            .collect();
        Compiled {
            rules,
            email: Regex::new(EMAIL_RE).ok(),
            card: Regex::new(CARD_RE).ok(),
            token: Regex::new(TOKEN_RE).ok(),
        }
    })
}

/// Redacts secrets with default options.
pub fn scrub(text: &str) -> ScrubOutcome {
    scrub_with(text, &ScrubberOptions::default())
}

pub fn scrub_with(text: &str, options: &ScrubberOptions) -> ScrubOutcome {
    let c = compiled();
    let mut found: Vec<Redaction> = Vec::new();

    for rule in &c.rules {
        for caps in rule.regex.captures_iter(text) {
            if let Some(m) = caps.get(rule.group) {
                found.push(Redaction {
                    kind: rule.kind,
                    start: m.start(),
                    end: m.end(),
                });
            }
        }
    }
    if options.redact_emails
        && let Some(re) = &c.email
    {
        {
            for m in re.find_iter(text) {
                let overlaps = found.iter().any(|r| m.start() < r.end && r.start < m.end());
                if !overlaps && !is_placeholder_email(m.as_str()) {
                    found.push(Redaction {
                        kind: SecretKind::Email,
                        start: m.start(),
                        end: m.end(),
                    });
                }
            }
        }
    }
    if let Some(re) = &c.card {
        for m in re.find_iter(text) {
            let digits: Vec<u32> = m
                .as_str()
                .chars()
                .filter_map(|ch| ch.to_digit(10))
                .collect();
            let overlaps = found.iter().any(|r| m.start() < r.end && r.start < m.end());
            if !overlaps && (13..=19).contains(&digits.len()) && luhn_valid(&digits) {
                found.push(Redaction {
                    kind: SecretKind::CreditCard,
                    start: m.start(),
                    end: m.end(),
                });
            }
        }
    }
    if let Some(re) = &c.token {
        for m in re.find_iter(text) {
            let overlaps = found.iter().any(|r| m.start() < r.end && r.start < m.end());
            if !overlaps && looks_high_entropy(m.as_str(), options) {
                found.push(Redaction {
                    kind: SecretKind::HighEntropy,
                    start: m.start(),
                    end: m.end(),
                });
            }
        }
    }

    let redactions = merge(found);
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    for r in &redactions {
        out.push_str(&text[cursor..r.start]);
        out.push_str("[REDACTED:");
        out.push_str(r.kind.as_str());
        out.push(']');
        cursor = r.end;
    }
    out.push_str(&text[cursor..]);
    ScrubOutcome {
        text: out,
        redactions,
    }
}

/// Sorts by start and drops redactions overlapping an earlier (or longer) one.
fn merge(mut found: Vec<Redaction>) -> Vec<Redaction> {
    found.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end)));
    let mut merged: Vec<Redaction> = Vec::with_capacity(found.len());
    for r in found {
        match merged.last_mut() {
            Some(last) if r.start < last.end => {
                if r.end > last.end {
                    last.end = r.end;
                }
            }
            _ => merged.push(r),
        }
    }
    merged
}

fn is_placeholder_email(email: &str) -> bool {
    let domain = email
        .rsplit('@')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    domain.ends_with("example.com")
        || domain.ends_with("example.org")
        || domain.ends_with("example.net")
        || domain.ends_with("users.noreply.github.com")
        || domain == "localhost"
}

/// Luhn checksum over decimal digits.
pub fn luhn_valid(digits: &[u32]) -> bool {
    let sum: u32 = digits
        .iter()
        .rev()
        .enumerate()
        .map(|(i, d)| {
            if i % 2 == 1 {
                let doubled = d * 2;
                if doubled > 9 { doubled - 9 } else { doubled }
            } else {
                *d
            }
        })
        .sum();
    !digits.is_empty() && sum.is_multiple_of(10)
}

/// Shannon entropy in bits per character.
pub fn shannon_entropy(s: &str) -> f64 {
    let mut counts = std::collections::HashMap::new();
    let mut total = 0usize;
    for ch in s.chars() {
        *counts.entry(ch).or_insert(0usize) += 1;
        total += 1;
    }
    if total == 0 {
        return 0.0;
    }
    let total = total as f64;
    counts
        .values()
        .map(|&n| {
            let p = n as f64 / total;
            -p * p.log2()
        })
        .sum()
}

fn looks_high_entropy(token: &str, options: &ScrubberOptions) -> bool {
    if token.len() < options.entropy_min_len {
        return false;
    }
    let has_digit = token.bytes().any(|b| b.is_ascii_digit());
    let has_upper = token.bytes().any(|b| b.is_ascii_uppercase());
    let has_lower = token.bytes().any(|b| b.is_ascii_lowercase());
    // Hex digests / UUID-like strings have ≤ 4 bits/char and stay untouched.
    has_digit && has_upper && has_lower && shannon_entropy(token) >= options.entropy_threshold
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(text: &str) -> Vec<&'static str> {
        scrub(text)
            .redactions
            .iter()
            .map(|r| r.kind.as_str())
            .collect()
    }

    #[test]
    fn redacts_provider_tokens() {
        let text = "openai sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 and \
                    gh ghp_abcdefghijklmnopqrstuvwxyz0123456789AB and aws AKIAIOSFODNN7EXAMPLE";
        let out = scrub(text);
        assert_eq!(out.count(), 3);
        assert!(!out.text.contains("sk-proj-"));
        assert!(out.text.contains("[REDACTED:openai_key]"));
        assert!(out.text.contains("[REDACTED:github_token]"));
        assert!(out.text.contains("[REDACTED:aws_access_key]"));
        assert!(kinds("key sk-ant-api03-abcdefghijklmnopqrstuvwxyz").contains(&"anthropic_key"));
    }

    #[test]
    fn redacts_pem_jwt_and_env_values() {
        let pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA\n-----END OPENSSH PRIVATE KEY-----";
        assert_eq!(scrub(pem).text, "[REDACTED:private_key]");
        let jwt = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
        assert!(kinds(jwt).contains(&"jwt"));
        let env =
            "DATABASE_PASSWORD=hunter2hunter2\nexport STRIPE_API_KEY=\"abcd1234\"\nDEBUG=true";
        let out = scrub(env);
        assert!(out.text.contains("DATABASE_PASSWORD=[REDACTED:env_secret]"));
        assert!(out.text.contains("DEBUG=true"));
        assert_eq!(out.count(), 2);
        let url = "postgres://admin:s3cr3tP4ss@db.internal:5432/app";
        assert_eq!(
            scrub(url).text,
            "postgres://admin:[REDACTED:connection_string]@db.internal:5432/app"
        );
    }

    #[test]
    fn emails_cards_and_placeholders() {
        let out = scrub("mail juan.perez@empresa.co or test@example.com, card 4111 1111 1111 1111");
        assert!(out.text.contains("[REDACTED:email]"));
        assert!(out.text.contains("test@example.com"));
        assert!(out.text.contains("[REDACTED:credit_card]"));
        // Not Luhn-valid -> kept (order ids, phone numbers...)
        assert!(scrub("order 1234 5678 9012 3456").redactions.is_empty());
        let no_mail = ScrubberOptions {
            redact_emails: false,
            ..ScrubberOptions::default()
        };
        assert!(scrub_with("a@empresa.co", &no_mail).redactions.is_empty());
    }

    #[test]
    fn entropy_pass_catches_unknown_tokens_but_not_hashes_or_code() {
        let unknown = "token=Zx9Kq2Lm8Vn4Bt7Rc1Wd5Hy3Pf6Gs0JuXa8Qe2Mo";
        assert!(
            kinds(unknown)
                .iter()
                .any(|k| *k == "high_entropy" || *k == "env_secret")
        );
        let sha = "content_hash e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        assert!(scrub(sha).redactions.is_empty());
        let uuid = "id 0190a4b2-7c3d-7e8f-9a0b-1c2d3e4f5a6b and fn handle_save_memory_request_v2";
        assert!(scrub(uuid).redactions.is_empty());
        assert!(
            scrub("let reusable_snippet = memory.reusable_snippet.clone();")
                .redactions
                .is_empty()
        );
    }

    #[test]
    fn luhn_and_entropy_helpers() {
        assert!(luhn_valid(&[
            4, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1
        ]));
        assert!(!luhn_valid(&[1, 2, 3, 4]));
        assert!(shannon_entropy("aaaa") < 0.01);
        assert!((shannon_entropy("ab") - 1.0).abs() < 1e-9);
    }

    #[test]
    fn plain_text_is_untouched() {
        let text =
            "Decidimos usar SQLite en modo WAL porque evita SQLITE_BUSY con varios lectores.";
        let out = scrub(text);
        assert_eq!(out.text, text);
        assert!(out.redactions.is_empty());
    }
}
