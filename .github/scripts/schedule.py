"""UTC cron candidates are filtered in America/Chicago, including DST."""
import argparse
import datetime as dt
import os
from zoneinfo import ZoneInfo


def should_run(kind, event, cron, now):
    if event == "workflow_dispatch":
        return True
    local = now.astimezone(ZoneInfo("America/Chicago"))
    day, hour = local.weekday(), local.hour  # Monday=0
    if kind == "wake":
        if cron == "0 * * * *":
            return True
        return (day == 3 and hour >= 10) or day in (4, 5) or (day == 6 and hour < 3)
    if cron == "0 11,12 * * *":
        return hour == 6
    if cron == "30 12,13 * * 0":
        return day == 6 and hour == 7
    return (day == 5 and 10 <= hour <= 22 and hour % 2 == 0) or (day == 6 and hour == 0)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("kind", choices=["refresh", "wake"])
    args = parser.parse_args()
    now = dt.datetime.now(dt.timezone.utc)
    run = should_run(args.kind, os.environ["EVENT_NAME"], os.environ.get("EVENT_SCHEDULE", ""), now)
    print(f"Central time: {now.astimezone(ZoneInfo('America/Chicago')).isoformat()}; run={run}")
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"run={'true' if run else 'false'}\n")
