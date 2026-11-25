use cobalt_core::enums::TokenEncoding;
use cobalt_core::traits::TokenCounter;
use tiktoken_rs::{CoreBPE, cl100k_base_singleton, o200k_base_singleton};

#[derive(Clone, Copy)]
pub struct TiktokenCounter {
    encoding: TokenEncoding,
    tokenizer: &'static CoreBPE,
}

impl TiktokenCounter {
    pub fn new(encoding: TokenEncoding) -> Self {
        let tokenizer = match encoding {
            TokenEncoding::Cl100kBase => cl100k_base_singleton(),
            TokenEncoding::O200kBase => o200k_base_singleton(),
        };
        Self {
            encoding,
            tokenizer,
        }
    }
}

impl TokenCounter for TiktokenCounter {
    fn encoding(&self) -> TokenEncoding {
        self.encoding
    }

    fn count(&self, text: &str) -> usize {
        self.tokenizer.count_ordinary(text)
    }

    fn truncate(&self, text: &str, max_tokens: usize) -> String {
        let tokens = self.tokenizer.encode_ordinary(text);
        if tokens.len() <= max_tokens {
            return text.to_owned();
        }
        // A BPE boundary can split a UTF-8 character. Walk back to a complete boundary.
        for end in (1..=max_tokens).rev() {
            let Ok(bytes) = self.tokenizer.decode_bytes(&tokens[..end]) else {
                break;
            };
            let Ok(prefix) = String::from_utf8(bytes) else {
                continue;
            };
            if self.count(&prefix) <= max_tokens {
                return prefix;
            }
        }
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_and_truncates_both_vocabularies_on_valid_utf8() {
        let text = "Hola mundo 🦊, おはようございます <|endoftext|>";
        for encoding in TokenEncoding::ALL {
            let counter = TiktokenCounter::new(*encoding);
            assert_eq!(counter.encoding(), *encoding);
            assert_eq!(counter.count("hello world"), 2);
            assert!(counter.count("<|endoftext|>") > 1);
            assert_eq!(counter.truncate("", 1), "");
            assert_eq!(counter.truncate(text, 0), "");
            for cap in 1..=counter.count(text) {
                let result = counter.truncate(text, cap);
                assert!(text.starts_with(&result));
                assert!(counter.count(&result) <= cap);
            }
            assert_eq!(counter.truncate(text, usize::MAX), text);
        }
    }
}
