use serde_json::{Map, Value};

pub type WarnCallback<'a> = dyn FnMut(&str) + 'a;

pub fn warn(warn: &mut WarnCallback<'_>, message: impl Into<String>) {
    let message = message.into();
    tracing::warn!(message = %message, "state normalization warning");
    warn(&message);
}

#[must_use]
pub fn normalize_conflict_graph(raw: Option<&Value>, warn_cb: &mut WarnCallback<'_>) -> Value {
    let Some(Value::Object(graph)) = raw else {
        return empty_conflict_graph();
    };

    let edges = match graph.get("edges") {
        Some(Value::Array(raw_edges)) => raw_edges
            .iter()
            .enumerate()
            .filter_map(|(idx, edge)| {
                normalize_edge(edge).or_else(|| {
                    warn(
                        warn_cb,
                        format!("Warning: invalid conflict_graph.edges[{idx}]; skipping."),
                    );
                    None
                })
            })
            .map(|(from, to)| Value::Array(vec![Value::String(from), Value::String(to)]))
            .collect(),
        Some(_) => {
            warn(
                warn_cb,
                "Warning: invalid conflict_graph.edges; using empty graph.",
            );
            Vec::new()
        }
        None => Vec::new(),
    };

    let mut normalized = Map::new();
    normalized.insert("edges".to_owned(), Value::Array(edges));
    normalized.insert(
        "computed_at".to_owned(),
        graph
            .get("computed_at")
            .and_then(Value::as_str)
            .map(|value| Value::String(value.to_owned()))
            .unwrap_or(Value::Null),
    );
    Value::Object(normalized)
}

fn normalize_edge(raw: &Value) -> Option<(String, String)> {
    match raw {
        Value::Array(items) => {
            let from = items.first()?.as_str()?;
            let to = items.get(1)?.as_str()?;
            Some((from.to_owned(), to.to_owned()))
        }
        Value::Object(edge) => {
            let from = edge.get("from")?.as_str()?;
            let to = edge.get("to")?.as_str()?;
            Some((from.to_owned(), to.to_owned()))
        }
        _ => None,
    }
}

#[must_use]
pub fn normalize_decisions_log(
    raw: Option<&Value>,
    entry_key: &str,
    warn_cb: &mut WarnCallback<'_>,
) -> Value {
    let Some(Value::Array(items)) = raw else {
        if raw.is_some() {
            warn(
                warn_cb,
                format!(
                    "Warning: invalid .entries[{entry_key:?}].decisions_log; using empty list."
                ),
            );
        }
        return Value::Array(Vec::new());
    };

    let decisions = items
        .iter()
        .enumerate()
        .filter_map(|(idx, item)| {
            normalize_decision(item).or_else(|| {
                warn(
                    warn_cb,
                    format!(
                        "Warning: invalid .entries[{entry_key:?}].decisions_log[{idx}]; skipping."
                    ),
                );
                None
            })
        })
        .collect();
    Value::Array(decisions)
}

fn normalize_decision(raw: &Value) -> Option<Value> {
    let Value::Object(item) = raw else {
        return None;
    };
    let ts = item.get("ts")?.as_str()?;
    let prompt_tag = item.get("prompt_tag")?.as_str()?;
    let answer = item.get("answer")?.as_str()?;
    let mut normalized = Map::new();
    normalized.insert("ts".to_owned(), Value::String(ts.to_owned()));
    normalized.insert(
        "prompt_tag".to_owned(),
        Value::String(prompt_tag.to_owned()),
    );
    normalized.insert("answer".to_owned(), Value::String(answer.to_owned()));
    Some(Value::Object(normalized))
}

#[must_use]
pub fn normalize_merge_queue(raw: Option<&Value>, warn_cb: &mut WarnCallback<'_>) -> Value {
    let Some(Value::Array(items)) = raw else {
        if raw.is_some() {
            warn(
                warn_cb,
                "Warning: invalid merge_queue; using empty merge queue.",
            );
        }
        return Value::Array(Vec::new());
    };

    let queue = items
        .iter()
        .enumerate()
        .filter_map(|(idx, item)| {
            item.as_str()
                .map(|value| Value::String(value.to_owned()))
                .or_else(|| {
                    warn(
                        warn_cb,
                        format!("Warning: invalid merge_queue[{idx}]; skipping."),
                    );
                    None
                })
        })
        .collect();
    Value::Array(queue)
}

fn empty_conflict_graph() -> Value {
    let mut graph = Map::new();
    graph.insert("edges".to_owned(), Value::Array(Vec::new()));
    graph.insert("computed_at".to_owned(), Value::Null);
    Value::Object(graph)
}
