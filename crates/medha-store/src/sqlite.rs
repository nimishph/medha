use std::collections::HashMap;
use std::fs;
use std::path::Path;

use rusqlite::params;
use rusqlite::Connection;

use crate::errors::StoreError;
use crate::folding::{fold_episode_into_state, fold_log};
use crate::traits::StorePort;
use crate::types::{
    AppendResult, CorruptLocation, EntityKey, EntityState, Episode, EpisodeInput, EpisodePayload,
    OpenResult, ReplaceLogResult, StoreRegistries,
};

pub const CURRENT_LAYOUT_VERSION: u32 = 1;

pub struct SqliteStoreOptions {
    pub path: String,
    pub registries: Option<StoreRegistries>,
    pub resilient_replay: bool,
}

pub struct SqliteStore {
    path: String,
    registries: StoreRegistries,
    #[allow(dead_code)]
    resilient_replay: bool,
    conn: Option<Connection>,
    log: Vec<Episode>,
    projection: HashMap<String, EntityState>,
    next_seq: u64,
    opened: bool,
    loaded: bool,
    corrupt_at: Option<u64>,
}

impl SqliteStore {
    pub fn new(options: SqliteStoreOptions) -> Self {
        Self {
            path: options.path,
            registries: options.registries.unwrap_or_default(),
            resilient_replay: options.resilient_replay,
            conn: None,
            log: Vec::new(),
            projection: HashMap::new(),
            next_seq: 0,
            opened: false,
            loaded: false,
            corrupt_at: None,
        }
    }

    fn require_conn(&self) -> Result<&Connection, StoreError> {
        self.conn.as_ref().ok_or(StoreError::StoreClosed("operation"))
    }

    fn require_conn_mut(&mut self) -> Result<&mut Connection, StoreError> {
        self.conn.as_mut().ok_or(StoreError::StoreClosed("operation"))
    }

    fn assert_open(&self, op: &'static str) -> Result<(), StoreError> {
        if !self.opened {
            return Err(StoreError::StoreClosed(op));
        }
        Ok(())
    }

    fn accept(&mut self, episode: Episode) -> Option<EntityState> {
        self.log.push(episode.clone());
        self.next_seq = episode.seq + 1;

        if let EpisodePayload::Retract { .. } = &episode.payload {
            self.projection = fold_log(&self.log);
            return self.projection.get(&episode.key.to_string_repr()).cloned();
        }

        let key_str = episode.key.to_string_repr();
        let curr = self.projection.remove(&key_str);
        if let Some(next) = fold_episode_into_state(curr, &episode) {
            self.projection.insert(key_str, next.clone());
            Some(next)
        } else {
            None
        }
    }
}

impl StorePort for SqliteStore {
    fn name(&self) -> &'static str {
        "sqlite"
    }

    fn registries(&self) -> &StoreRegistries {
        &self.registries
    }

    fn is_open(&self) -> bool {
        self.opened
    }

    fn open(&mut self) -> Result<OpenResult, StoreError> {
        self.opened = true;

        if self.path != ":memory:" {
            if let Some(parent) = Path::new(&self.path).parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| StoreError::Database(format!("Failed to create parent dir: {}", e)))?;
            }
        }

        let conn = if self.path == ":memory:" {
            Connection::open_in_memory()?
        } else {
            Connection::open(&self.path)?
        };

        if self.path != ":memory:" {
            let _: String = conn.query_row("PRAGMA journal_mode = WAL;", [], |r| r.get(0))?;
            conn.execute("PRAGMA synchronous = FULL;", [])?;
        }

        conn.execute(
            "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
            [],
        )?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS episodes (seq INTEGER PRIMARY KEY, json TEXT NOT NULL);",
            [],
        )?;

        if !self.loaded {
            self.loaded = true;
            let layout_val: Option<String> = conn
                .query_row("SELECT value FROM meta WHERE key = 'layout'", [], |r| {
                    r.get(0)
                })
                .ok();

            match layout_val {
                None => {
                    conn.execute(
                        "INSERT INTO meta (key, value) VALUES ('layout', ?1)",
                        params![CURRENT_LAYOUT_VERSION.to_string()],
                    )?;
                }
                Some(v) => {
                    let version: u32 = v.parse().unwrap_or(0);
                    if version > CURRENT_LAYOUT_VERSION {
                        return Err(StoreError::StoreLayout {
                            found: version,
                            supported: CURRENT_LAYOUT_VERSION,
                        });
                    }
                }
            }

            let mut stmt = conn.prepare("SELECT seq, json FROM episodes ORDER BY seq")?;
            let rows = stmt.query_map([], |row| {
                let seq: u64 = row.get(0)?;
                let json: String = row.get(1)?;
                Ok((seq, json))
            })?;

            for r in rows {
                let (seq, json_str) = r?;
                let episode: Episode = match serde_json::from_str(&json_str) {
                    Ok(ep) => ep,
                    Err(_) => {
                        self.corrupt_at = Some(seq);
                        break;
                    }
                };

                if episode.seq != self.next_seq {
                    self.corrupt_at = Some(seq);
                    break;
                }

                self.accept(episode);
            }
        }

        self.conn = Some(conn);

        if let Some(bad_seq) = self.corrupt_at {
            Ok(OpenResult::Corrupt {
                location: CorruptLocation {
                    source: self.path.clone(),
                    at_seq: bad_seq,
                },
            })
        } else {
            Ok(OpenResult::Ok)
        }
    }

    fn close(&mut self) -> Result<(), StoreError> {
        self.conn = None;
        self.opened = false;
        Ok(())
    }

    fn append(&mut self, input: EpisodeInput) -> Result<AppendResult, StoreError> {
        self.assert_open("append")?;
        if let Some(bad_seq) = self.corrupt_at {
            return Err(StoreError::CorruptStore {
                store_path: self.path.clone(),
                at_seq: bad_seq,
                reason: format!("Cannot append to corrupt store: unrecoverable from seq {}", bad_seq),
            });
        }

        let seq = self.next_seq;
        let episode = Episode {
            seq,
            key: input.key,
            at: input.at,
            author: input.author,
            payload: input.payload,
        };

        let json = serde_json::to_string(&episode)?;
        {
            let conn = self.require_conn_mut()?;
            conn.execute(
                "INSERT INTO episodes (seq, json) VALUES (?1, ?2)",
                params![seq, json],
            )?;
        }

        let state = self.accept(episode.clone());
        Ok(AppendResult { episode, state })
    }

    fn episodes(
        &self,
        after_seq: Option<i64>,
        limit: Option<usize>,
    ) -> Result<Vec<Episode>, StoreError> {
        self.assert_open("episodes")?;
        let from = after_seq.unwrap_or(-1);
        let cursor = self.corrupt_at.unwrap_or(u64::MAX);

        let filtered: Vec<Episode> = self
            .log
            .iter()
            .filter(|e| (e.seq as i64) > from && e.seq < cursor)
            .cloned()
            .collect();

        if let Some(lim) = limit {
            Ok(filtered.into_iter().take(lim).collect())
        } else {
            Ok(filtered)
        }
    }

    fn get(&self, key: &EntityKey) -> Result<Option<EntityState>, StoreError> {
        self.assert_open("get")?;
        Ok(self.projection.get(&key.to_string_repr()).cloned())
    }

    fn list(&self) -> Result<Vec<EntityState>, StoreError> {
        self.assert_open("list")?;
        let mut states: Vec<EntityState> = self.projection.values().cloned().collect();
        states.sort_by(|a, b| a.key.to_string_repr().cmp(&b.key.to_string_repr()));
        Ok(states)
    }

    fn rebuild(&mut self) -> Result<Vec<EntityState>, StoreError> {
        self.assert_open("rebuild")?;
        self.projection = fold_log(&self.log);
        let mut states: Vec<EntityState> = self.projection.values().cloned().collect();
        states.sort_by(|a, b| a.key.to_string_repr().cmp(&b.key.to_string_repr()));
        Ok(states)
    }

    fn replace_log(&mut self, episodes: &[Episode]) -> Result<ReplaceLogResult, StoreError> {
        self.assert_open("replace_log")?;
        if let Some(bad_seq) = self.corrupt_at {
            return Err(StoreError::CorruptStore {
                store_path: self.path.clone(),
                at_seq: bad_seq,
                reason: format!("Cannot replace log of corrupt store from seq {}", bad_seq),
            });
        }

        let from = 0;
        let to = if self.log.is_empty() { 0 } else { self.log.len() as u64 - 1 };

        let conn = self.require_conn_mut()?;
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM episodes", [])?;
        {
            let mut insert_stmt = tx.prepare("INSERT INTO episodes (seq, json) VALUES (?1, ?2)")?;
            for ep in episodes {
                let json = serde_json::to_string(ep)?;
                insert_stmt.execute(params![ep.seq, json])?;
            }
        }
        tx.commit()?;

        self.log.clear();
        self.projection.clear();
        self.next_seq = 0;

        for ep in episodes {
            self.accept(ep.clone());
        }

        Ok(ReplaceLogResult { from, to })
    }

    fn get_meta(&self, key: &str) -> Result<Option<String>, StoreError> {
        self.assert_open("get_meta")?;
        let conn = self.require_conn()?;
        let val: Option<String> = conn
            .query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| {
                r.get(0)
            })
            .ok();
        Ok(val)
    }

    fn set_meta(&mut self, key: &str, value: &str) -> Result<(), StoreError> {
        self.assert_open("set_meta")?;
        let conn = self.require_conn_mut()?;
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }
}
