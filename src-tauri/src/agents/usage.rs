//! What an agent spends, for its daily limit. Its program reports the cost
//! of its session as a running total after every turn; `Meter` turns that
//! into what each report adds, and `Usage` keeps the agent's total for the
//! day: in its project's rows in the database (`store::usage`), or only in
//! memory for a folder opened without a project.

use std::sync::{Arc, Mutex};

use crate::store::{self, DbRef};

/// The computer's calendar day now, as spending is counted: "YYYY-MM-DD".
pub fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// The day `days` days before today, in the same form.
pub fn days_ago(days: u64) -> String {
    let day = chrono::Local::now().date_naive();
    day.checked_sub_days(chrono::Days::new(days)).unwrap_or(day).format("%Y-%m-%d").to_string()
}

/// How long until just after the next local midnight, when a new day's
/// spending starts.
pub fn until_tomorrow() -> Option<std::time::Duration> {
    let now = chrono::Local::now();
    let next = now.date_naive().checked_add_days(chrono::Days::new(1))?.and_hms_opt(0, 0, 1)?;
    (next.and_local_timezone(chrono::Local).earliest()? - now).to_std().ok()
}

/// A daily limit as the user wrote it, in US dollars: "" is no limit, and
/// "5", "$5.00", "5 USD" and "5,50" are amounts. Anything else is Err.
pub fn parse_limit(text: &str) -> Result<Option<f64>, ()> {
    let text = text.trim().to_ascii_lowercase();
    if text.is_empty() {
        return Ok(None);
    }
    let text = ["us$", "$", "usd"].iter().find_map(|mark| text.strip_prefix(mark)).unwrap_or(&text).trim();
    let text = ["usd", "$"].iter().find_map(|mark| text.strip_suffix(mark)).unwrap_or(text).trim();
    // A comma is the decimal mark ("5,50") unless there is a point too ("1,250.50").
    let number = if text.contains('.') { text.replace(',', "") } else { text.replace(',', ".") };
    let plain = number.chars().all(|c| c.is_ascii_digit() || c == '.') && number.chars().any(|c| c.is_ascii_digit());
    match number.parse::<f64>() {
        Ok(usd) if plain && usd.is_finite() => Ok(Some(usd)),
        _ => Err(()),
    }
}

/// Money as the interface shows it: "$5.00".
pub fn dollars(usd: f64) -> String {
    format!("${usd:.2}")
}

/// Turns the running cost total a session reports into what each report
/// adds. A total lower than the last one means the session started again
/// from zero (it was rebuilt, or its program restarted), so all of it is new.
#[derive(Default, Debug)]
pub struct Meter {
    last: Option<f64>,
}

impl Meter {
    /// What this report adds; None for a total that is not a cost.
    pub fn added(&mut self, total: f64) -> Option<f64> {
        if !total.is_finite() || total < 0.0 {
            return None;
        }
        let added = match self.last {
            Some(last) if total >= last => total - last,
            _ => total,
        };
        self.last = Some(total);
        Some(added)
    }
}

/// Where an agent's spend is kept between runs: its project's rows.
pub struct Books {
    pub db: DbRef,
    pub project: String,
}

type Clock = Arc<dyn Fn() -> String + Send + Sync>;

#[derive(Default)]
struct Spent {
    /// The day `today` is for; empty until first read.
    day: String,
    today: f64,
    /// What the current turn has cost so far.
    turn: f64,
}

/// An agent's spend for the day, and for its current turn.
pub struct Usage {
    agent_id: String,
    books: Mutex<Option<Books>>,
    /// Today's date; tests set their own.
    clock: Mutex<Clock>,
    spent: Mutex<Spent>,
}

impl Usage {
    pub fn new(agent_id: &str) -> Self {
        Self { agent_id: agent_id.to_string(), books: Mutex::default(), clock: Mutex::new(Arc::new(today)), spent: Mutex::default() }
    }

    /// Keeps the agent's spend in its project's rows from now on, counting
    /// on from what they hold for today.
    pub fn keep_in(&self, books: Books) {
        *self.books.lock().expect("books lock") = Some(books);
        self.spent.lock().expect("spent lock").day.clear();
    }

    #[cfg(test)]
    pub fn set_clock(&self, clock: impl Fn() -> String + Send + Sync + 'static) {
        *self.clock.lock().expect("clock lock") = Arc::new(clock);
    }

    fn day(&self) -> String {
        let clock = self.clock.lock().expect("clock lock").clone();
        clock()
    }

    /// Brings `spent` to `day`: a new day starts from what its row holds (nothing, normally).
    fn roll(&self, spent: &mut Spent, day: &str) {
        if spent.day == day {
            return;
        }
        let books = self.books.lock().expect("books lock");
        let saved = match books.as_ref() {
            Some(b) => b.db.with(|db| store::usage::spent(db, &b.project, &self.agent_id, day)).unwrap_or_else(|e| {
                eprintln!("could not read what {} spent: {e}", self.agent_id);
                0.0
            }),
            None => 0.0,
        };
        *spent = Spent { day: day.to_string(), today: saved, turn: spent.turn };
    }

    /// What the agent spent today.
    pub fn today(&self) -> f64 {
        let day = self.day();
        let mut spent = self.spent.lock().expect("spent lock");
        self.roll(&mut spent, &day);
        spent.today
    }

    /// A new turn starts: its cost counts from zero.
    pub fn start_turn(&self) {
        self.spent.lock().expect("spent lock").turn = 0.0;
    }

    /// Adds what a report says was spent, as one more turn that cost
    /// something. Returns today's total and the current turn's.
    pub fn add(&self, usd: f64) -> (f64, f64) {
        let day = self.day();
        let mut spent = self.spent.lock().expect("spent lock");
        self.roll(&mut spent, &day);
        let books = self.books.lock().expect("books lock");
        spent.today = match books.as_ref() {
            Some(b) => b.db.with(|db| store::usage::add(db, &b.project, &self.agent_id, &day, usd, 1)).unwrap_or_else(|e| {
                // Still counted for this run, so the limit holds until the app restarts.
                eprintln!("could not save what {} spent: {e}", self.agent_id);
                spent.today + usd
            }),
            None => spent.today + usd,
        };
        spent.turn += usd;
        (spent.today, spent.turn)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Db;

    #[test]
    fn limits_are_read_leniently() {
        for (text, limit) in [
            ("", None),
            ("  ", None),
            ("5", Some(5.0)),
            ("$5.00", Some(5.0)),
            (" $ 5 ", Some(5.0)),
            ("5,50", Some(5.5)),
            ("5 USD", Some(5.0)),
            ("usd 2.5", Some(2.5)),
            ("1,250.50", Some(1250.5)),
            (".5", Some(0.5)),
            ("0", Some(0.0)),
        ] {
            assert_eq!(parse_limit(text), Ok(limit), "{text:?}");
        }
        for text in ["five", "-5", "+5", "5e3", "inf", "NaN", "$", "1,000,000", "5 dollars", "1.2.3"] {
            assert_eq!(parse_limit(text), Err(()), "{text:?}");
        }
        assert_eq!(dollars(5.0), "$5.00");
        assert!(until_tomorrow().is_some_and(|d| d <= std::time::Duration::from_secs(25 * 3600)));
        assert_eq!(dollars(0.304), "$0.30");
    }

    #[test]
    fn the_meter_counts_differences_and_notices_restarts() {
        let mut meter = Meter::default();
        let mut added = |total| meter.added(total).map(|a| (a * 1000.0).round() / 1000.0);
        assert_eq!(added(0.10), Some(0.10), "a new session's first report is all new");
        assert_eq!(added(0.25), Some(0.15));
        assert_eq!(added(0.25), Some(0.0), "nothing new");
        assert_eq!(added(0.05), Some(0.05), "lower: the session started again from zero");
        assert_eq!(added(0.07), Some(0.02));
        assert_eq!(added(f64::NAN), None);
        assert_eq!(added(-1.0), None);
        assert_eq!(added(0.08), Some(0.01), "bad reports change nothing");
    }

    #[test]
    fn spend_is_kept_per_day_in_the_projects_rows() {
        let db = Arc::new(Db::memory());
        db.lock()
            .unwrap()
            .execute("INSERT INTO projects (id, name, folder, created, last_opened) VALUES ('p1', 'p1', '/p1', 1, 1)", [])
            .unwrap();
        store::usage::add(&db, "p1", "a", "2026-10-10", 1.0, 1).unwrap();
        let day = Arc::new(Mutex::new("2026-10-10".to_string()));

        let usage = Usage::new("a");
        usage.set_clock({
            let day = day.clone();
            move || day.lock().unwrap().clone()
        });
        assert_eq!(usage.today(), 0.0, "in memory until it has a project");
        usage.keep_in(Books { db: DbRef::Own(db.clone()), project: "p1".into() });
        assert_eq!(usage.today(), 1.0, "what the project's row holds");
        usage.start_turn();
        assert_eq!(usage.add(0.5), (1.5, 0.5));
        assert_eq!(usage.add(0.25), (1.75, 0.75));
        assert_eq!(store::usage::spent(&db, "p1", "a", "2026-10-10").unwrap(), 1.75);

        // Past midnight a new day starts from nothing; the old one keeps its total.
        *day.lock().unwrap() = "2026-10-11".into();
        assert_eq!(usage.today(), 0.0);
        usage.start_turn();
        assert_eq!(usage.add(0.1), (0.1, 0.1));
        assert_eq!(store::usage::spent(&db, "p1", "a", "2026-10-10").unwrap(), 1.75);
        assert_eq!(store::usage::spent(&db, "p1", "a", "2026-10-11").unwrap(), 0.1);
        let days = store::usage::since(&db, "p1", "2026-10-10").unwrap();
        assert_eq!(days.iter().map(|d| d.turns).collect::<Vec<_>>(), [3, 1], "turns that reported a cost");
    }
}
