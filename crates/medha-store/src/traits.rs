use crate::errors::StoreError;
use crate::types::{
    AppendResult, EntityKey, EntityState, Episode, EpisodeInput, OpenResult, ReplaceLogResult,
    StoreRegistries,
};

pub trait StorePort {
    fn name(&self) -> &'static str;
    fn registries(&self) -> &StoreRegistries;
    fn is_open(&self) -> bool;
    fn open(&mut self) -> Result<OpenResult, StoreError>;
    fn close(&mut self) -> Result<(), StoreError>;
    fn append(&mut self, input: EpisodeInput) -> Result<AppendResult, StoreError>;
    fn episodes(
        &self,
        after_seq: Option<i64>,
        limit: Option<usize>,
    ) -> Result<Vec<Episode>, StoreError>;
    fn get(&self, key: &EntityKey) -> Result<Option<EntityState>, StoreError>;
    fn list(&self) -> Result<Vec<EntityState>, StoreError>;
    fn rebuild(&mut self) -> Result<Vec<EntityState>, StoreError>;
    fn replace_log(&mut self, episodes: &[Episode]) -> Result<ReplaceLogResult, StoreError>;
    fn get_meta(&self, key: &str) -> Result<Option<String>, StoreError>;
    fn set_meta(&mut self, key: &str, value: &str) -> Result<(), StoreError>;
}
