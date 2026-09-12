use crate::workspace::{self, Result};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};

#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq, Debug)]
pub enum Language {
    #[default]
    #[serde(rename = "zh-CN")]
    Chinese,
    #[serde(rename = "en")]
    English,
}
impl Language {
    pub fn text<'a>(self, chinese: &'a str, english: &'a str) -> &'a str {
        match self {
            Self::Chinese => chinese,
            Self::English => english,
        }
    }
}

#[derive(Default, Deserialize, Serialize)]
pub struct Preferences {
    #[serde(default)]
    pub language: Language,
    // Keep future preferences when changing only the language.
    #[serde(flatten)]
    other: serde_json::Map<String, serde_json::Value>,
}

pub fn read(path: &Path) -> Result<Preferences> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Preferences::default()),
        Err(error) => Err(error.to_string()),
    }
}

pub fn save_language(path: &Path, language: Language) -> Result<()> {
    let mut preferences = read(path)?;
    preferences.language = language;
    workspace::write_json(path, &preferences)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preferences_round_trip_without_losing_other_settings() {
        let dir = std::env::temp_dir().join(format!("viento-language-{}", uuid::Uuid::new_v4()));
        let file = dir.join("preferences.json");
        assert_eq!(read(&file).unwrap().language, Language::Chinese);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            &file,
            r#"{"language":"zh-CN","futureOption":{"enabled":true}}"#,
        )
        .unwrap();
        save_language(&file, Language::English).unwrap();
        let saved = read(&file).unwrap();
        assert_eq!(saved.language, Language::English);
        assert_eq!(saved.other["futureOption"]["enabled"], true);
        save_language(&file, Language::Chinese).unwrap();
        assert_eq!(read(&file).unwrap().language, Language::Chinese);
        assert!(serde_json::from_str::<Language>("\"../en\"").is_err());
        fs::write(&file, "broken").unwrap();
        assert!(save_language(&file, Language::English).is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), "broken");
        fs::remove_dir_all(dir).unwrap();
    }
}
