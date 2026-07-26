#!/usr/bin/env python3
"""Firefly III rules as code.

config/firefly/rules.json is the source of truth. Modes:
  --export   overwrite the file with the live rules
  (default)  diff file vs live; exit 1 on drift
  --apply    push the file to Firefly, then re-export to pick up new ids

Apply resends every trigger and action with an explicit active flag:
Firefly's rule update defaults a missing 'active' to false, which is how
a bulk edit silently disabled 17 actions on 2026-07-22.

Apply never deletes: rules that exist live but not in the file are
reported so removal stays a deliberate UI/API action followed by --export.
"""

import argparse
import json
import pathlib
import sys

from firefly_lib import Firefly

RULES_FILE = pathlib.Path(__file__).resolve().parent.parent / "config" / "firefly" / "rules.json"
TRIGGER_FIELDS = ("type", "value", "order", "active", "prohibited", "stop_processing")
ACTION_FIELDS = ("type", "value", "order", "active", "stop_processing")
RULE_FIELDS = ("title", "description", "rule_group_id", "order", "trigger", "active", "strict", "stop_processing")
GROUP_FIELDS = ("title", "description", "order", "active")


def snapshot_items(items, fields):
    ordered = sorted(items, key=lambda item: item["order"])
    return [{field: item.get(field) for field in fields} for item in ordered]


def snapshot_rule(rule):
    attrs = rule["attributes"]
    return {
        "id": rule["id"],
        **{field: attrs[field] for field in RULE_FIELDS},
        "triggers": snapshot_items(attrs["triggers"], TRIGGER_FIELDS),
        "actions": snapshot_items(attrs["actions"], ACTION_FIELDS),
    }


def snapshot_group(group):
    return {"id": group["id"], **{field: group["attributes"][field] for field in GROUP_FIELDS}}


def live_state(firefly):
    groups = sorted((snapshot_group(g) for g in firefly.paged("/rule-groups")), key=lambda g: g["order"])
    rules = sorted(
        (snapshot_rule(r) for r in firefly.paged("/rules")),
        key=lambda r: (int(r["rule_group_id"]), r["order"]),
    )
    return {"rule_groups": groups, "rules": rules}


def recorded_state():
    return json.loads(RULES_FILE.read_text())


def write_file(state):
    RULES_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {len(state['rule_groups'])} groups, {len(state['rules'])} rules to {RULES_FILE}")


def normalized(entry):
    return {key: value for key, value in entry.items() if key != "id"}


def drifted_fields(recorded, live):
    return [key for key, value in normalized(recorded).items() if value != normalized(live).get(key)]


def diff_entries(kind, recorded, live):
    live_by_id = {entry["id"]: entry for entry in live}
    recorded_ids = {entry["id"] for entry in recorded if entry.get("id")}
    lines = []
    for entry in recorded:
        match = live_by_id.get(entry.get("id"))
        if match is None:
            lines.append(f"missing live (would create): {kind} {entry['title']!r}")
            continue
        fields = drifted_fields(entry, match)
        if fields:
            lines.append(f"drift: {kind} {entry['id']} {entry['title']!r}: {', '.join(fields)}")
    lines.extend(
        f"live only (never deleted by --apply): {kind} {entry['id']} {entry['title']!r}"
        for entry in live
        if entry["id"] not in recorded_ids
    )
    return lines


def diff(firefly):
    recorded, live = recorded_state(), live_state(firefly)
    lines = diff_entries("group", recorded["rule_groups"], live["rule_groups"])
    lines += diff_entries("rule", recorded["rules"], live["rules"])
    print("\n".join(lines) if lines else "clean: file matches live rules")
    return bool(lines)


def rule_payload(rule):
    return {
        **{field: rule[field] for field in RULE_FIELDS},
        "triggers": rule["triggers"],
        "actions": rule["actions"],
    }


def push(firefly, path, entry, payload):
    """Create or update one entry; returns the id Firefly assigned on create."""
    entry_id = entry.get("id")
    if not entry_id:
        created = firefly.call("POST", path, payload)
        print(f"created {path} {payload['title']!r} -> id {created['data']['id']}")
        return created["data"]["id"]
    firefly.call("PUT", f"{path}/{entry_id}", payload)
    print(f"updated {path}/{entry_id} {payload['title']!r}")
    return entry_id


def apply(firefly):
    recorded, live = recorded_state(), live_state(firefly)
    live_groups = {entry["id"]: entry for entry in live["rule_groups"]}
    live_rules = {entry["id"]: entry for entry in live["rules"]}
    # A group created in this run gets a fresh id, but the rules in the file
    # still carry whatever the author wrote. Resolve group -> title -> real id
    # so those rules land in the group they name instead of a stale one.
    group_ids = {}
    title_by_recorded_id = {}
    for group in recorded["rule_groups"]:
        match = live_groups.get(group.get("id"))
        title_by_recorded_id[group.get("id")] = group["title"]
        stale = match is None or drifted_fields(group, match)
        pushed = stale and push(firefly, "/rule-groups", group, {field: group[field] for field in GROUP_FIELDS})
        group_ids[group["title"]] = pushed or group.get("id")
    for rule in recorded["rules"]:
        match = live_rules.get(rule.get("id"))
        if match is None or drifted_fields(rule, match):
            payload = rule_payload(rule)
            title = title_by_recorded_id.get(rule["rule_group_id"])
            payload["rule_group_id"] = group_ids.get(title, rule["rule_group_id"])
            push(firefly, "/rules", rule, payload)
    write_file(live_state(firefly))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--export", action="store_true", help="overwrite the file with live rules")
    mode.add_argument("--apply", action="store_true", help="push the file to Firefly")
    args = parser.parse_args()
    firefly = Firefly()
    if args.export:
        write_file(live_state(firefly))
        return
    if args.apply:
        apply(firefly)
        return
    sys.exit(diff(firefly))


main()
