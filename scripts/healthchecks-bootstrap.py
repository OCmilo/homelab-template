#!/usr/bin/env python3
"""Bootstrap the private Healthchecks administrator, project, and API keys."""

from __future__ import annotations

import os
import pathlib
import sys
import uuid

sys.path.insert(0, "/opt/healthchecks")
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "hc.settings")

import django

django.setup()

from django.contrib.auth import get_user_model

from hc.accounts.models import Profile, Project


RUNTIME = pathlib.Path("/opt/homelab/runtime")
MANAGEMENT_KEY = RUNTIME / "management-api-key"
PING_KEY = RUNTIME / "ping-key"
HOMEPAGE_ENV = RUNTIME / "homepage.env"


def write_secret(path: pathlib.Path, value: str) -> None:
    # Create the file already restricted. write_text() honours the umask, so
    # the key would sit world-readable until the chmod landed.
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        handle.write(value + "\n")
    # O_CREAT's mode is ignored when the file already exists.
    path.chmod(0o600)


email = os.environ.get(
    "HEALTHCHECKS_ADMIN_EMAIL", "admin@example.com"
).strip()
password = os.environ.get("HEALTHCHECKS_ADMIN_PASSWORD", "")
reset_password = os.environ.get("HEALTHCHECKS_RESET_PASSWORD") == "1"

if not password:
    raise SystemExit("HEALTHCHECKS_ADMIN_PASSWORD is required")

RUNTIME.mkdir(parents=True, exist_ok=True)
User = get_user_model()
user, created = User.objects.get_or_create(
    email=email, defaults={"username": uuid.uuid4().hex[:30]}
)
user.is_staff = True
user.is_superuser = True
if created or reset_password:
    user.set_password(password)
user.save()

timezone = os.environ.get("TZ") or "UTC"
profile = Profile.objects.for_user(user)
if profile.tz != timezone:
    profile.tz = timezone
    profile.save(update_fields=["tz"])

project = Project.objects.filter(owner=user, name="Homelab Jobs").first()
if project is None:
    project = Project(
        owner=user,
        name="Homelab Jobs",
        badge_key=uuid.uuid4().hex,
        show_slugs=True,
    )
    project.set_ping_key()
    project.save()
else:
    changed = False
    if not project.ping_key:
        project.set_ping_key()
        changed = True
    if not project.show_slugs:
        project.show_slugs = True
        changed = True
    if changed:
        project.save()

write_secret(PING_KEY, project.ping_key)

if MANAGEMENT_KEY.exists():
    management_key = MANAGEMENT_KEY.read_text().strip()
    key_project = Project.objects.for_api_key(
        management_key, accept_rw=True, accept_ro=False
    )
    if key_project != project:
        management_key = project.set_api_key()
        project.save(update_fields=["api_key"])
        write_secret(MANAGEMENT_KEY, management_key)
else:
    management_key = project.set_api_key()
    project.save(update_fields=["api_key"])
    write_secret(MANAGEMENT_KEY, management_key)

readonly_path = RUNTIME / "readonly-api-key"
if readonly_path.exists():
    readonly_key = readonly_path.read_text().strip()
    key_project = Project.objects.for_api_key(
        readonly_key, accept_rw=False, accept_ro=True
    )
    if key_project != project:
        readonly_key = project.set_api_key_readonly()
        project.save(update_fields=["api_key_readonly"])
        write_secret(readonly_path, readonly_key)
else:
    readonly_key = project.set_api_key_readonly()
    project.save(update_fields=["api_key_readonly"])
    write_secret(readonly_path, readonly_key)

write_secret(
    HOMEPAGE_ENV,
    "HOMEPAGE_VAR_HEALTHCHECKS_API_KEY=" + readonly_key,
)

print(f"Healthchecks bootstrap ready: {email}; project={project.name}")
