import datetime as dt
import unittest
from zoneinfo import ZoneInfo
from schedule import should_run


class ScheduleTests(unittest.TestCase):
    def at(self, local, kind, cron):
        now = dt.datetime.fromisoformat(local).replace(tzinfo=ZoneInfo("America/Chicago"))
        return should_run(kind, "schedule", cron, now.astimezone(dt.timezone.utc))

    def test_daily_both_sides_of_dst(self):
        for date in ("2026-10-31", "2026-11-01", "2027-03-14"):
            self.assertTrue(self.at(date + "T06:00:00", "refresh", "0 11,12 * * *"))
            self.assertFalse(self.at(date + "T05:00:00", "refresh", "0 11,12 * * *"))
            self.assertFalse(self.at(date + "T07:00:00", "refresh", "0 11,12 * * *"))

    def test_saturday_midnight_and_sunday_review(self):
        for date in ("2026-10-31", "2026-11-07"):
            for hour in range(10, 23):
                self.assertEqual(self.at(f"{date}T{hour:02}:00:00", "refresh", "0 15-23 * * 6"), hour % 2 == 0)
        for date in ("2026-11-01", "2026-11-08"):
            self.assertTrue(self.at(date + "T00:00:00", "refresh", "0 0-6 * * 0"))
            self.assertFalse(self.at(date + "T01:00:00", "refresh", "0 0-6 * * 0"))
            self.assertTrue(self.at(date + "T07:35:00", "refresh", "30 12,13 * * 0"))
            self.assertFalse(self.at(date + "T08:30:00", "refresh", "30 12,13 * * 0"))

    def test_wake_window_and_hourly_fallback(self):
        for date in ("2026-10-29", "2026-11-05"):
            self.assertFalse(self.at(date + "T09:45:00", "wake", "15,30,45 15-23 * * 4"))
            self.assertTrue(self.at(date + "T10:15:00", "wake", "15,30,45 15-23 * * 4"))
        self.assertTrue(self.at("2026-11-01T02:45:00", "wake", "15,30,45 0-8 * * 0"))
        self.assertFalse(self.at("2026-11-01T03:15:00", "wake", "15,30,45 0-8 * * 0"))
        self.assertTrue(self.at("2026-11-02T04:00:00", "wake", "0 * * * *"))

    def test_manual_always_runs(self):
        self.assertTrue(should_run("refresh", "workflow_dispatch", "", dt.datetime.now(dt.timezone.utc)))
        self.assertTrue(should_run("wake", "workflow_dispatch", "", dt.datetime.now(dt.timezone.utc)))

    def test_actual_utc_candidates_across_fall_transition(self):
        # Enumerate the real cron candidates; there must be no duplicate local
        # refreshes and no missing waking intervals before/after November 1.
        start = dt.datetime(2026, 10, 26, tzinfo=dt.timezone.utc)
        refreshes, wakes = set(), set()
        for minute in range(14 * 24 * 60):
            now = start + dt.timedelta(minutes=minute)
            weekday, hour, m = now.weekday(), now.hour, now.minute
            refresh_crons = []
            if m == 0 and hour in (11, 12):
                refresh_crons.append("0 11,12 * * *")
            if m == 0 and weekday == 5 and 15 <= hour <= 23:
                refresh_crons.append("0 15-23 * * 6")
            if m == 0 and weekday == 6 and 0 <= hour <= 6:
                refresh_crons.append("0 0-6 * * 0")
            if m == 30 and weekday == 6 and hour in (12, 13):
                refresh_crons.append("30 12,13 * * 0")
            local = now.astimezone(ZoneInfo("America/Chicago"))
            key = local.strftime("%Y-%m-%d %H:%M")
            for cron in refresh_crons:
                if should_run("refresh", "schedule", cron, now):
                    self.assertNotIn(key, refreshes)
                    refreshes.add(key)
            wake_cron = None
            if m == 0:
                wake_cron = "0 * * * *"
            elif m in (15, 30, 45) and ((weekday == 3 and hour >= 15) or weekday in (4, 5) or (weekday == 6 and hour <= 8)):
                wake_cron = "quarter-hour candidate"
            if wake_cron and should_run("wake", "schedule", wake_cron, now):
                wakes.add(key)
        for date in ("2026-10-31", "2026-11-07"):
            for hour in range(10, 23, 2):
                self.assertIn(f"{date} {hour:02}:00", refreshes)
        for date in ("2026-11-01", "2026-11-08"):
            for time in ("00:00", "06:00", "07:30"):
                self.assertIn(f"{date} {time}", refreshes)
            for time in ("02:15", "02:30", "02:45", "03:00"):
                self.assertIn(f"{date} {time}", wakes)
            self.assertNotIn(f"{date} 03:15", wakes)


if __name__ == "__main__":
    unittest.main()
