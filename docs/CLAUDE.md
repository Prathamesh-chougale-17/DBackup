# Documentation and Changelog

VitePress wiki in `docs/`. Content language is English. Tone is clear, concise, and practical - written for self-hosters and sysadmins. No marketing fluff, no restating the obvious.

Local preview: `pnpm docs:dev`.

---

# Part 1 - Wiki pages

## Adapter guide template

Every adapter guide (sources, destinations, notifications) follows this section order. Omit a section only when it genuinely does not apply.

```markdown
# Adapter Name

One-sentence description of what this adapter does.

## Supported Versions        (databases only)

Version table.

## Prerequisites             (if needed)

CLI tools, external accounts, or setup required BEFORE configuring in DBackup.

## Configuration

| Field | Description | Default | Required |
| :--- | :--- | :--- | :--- |
| **Field Name** | What it does | `default` | ✅ / ❌ |

## Setup Guide

Numbered steps to configure this adapter in DBackup.
External setup (e.g. "Create Discord webhook") goes in as sub-steps.

## How It Works            (optional, only if non-obvious)

Brief explanation of the backup/upload/notification process.

## Troubleshooting

### Problem Title

\`\`\`
Error message or symptom
\`\`\`

**Solution:** Concrete fix.

## Next Steps

2-3 links to related pages (encryption, retention, restore).
```

### Rules

1. **One config table.** Do not split into "Basic" and "Advanced". One table, all fields.
2. **Required column** on every config table (✅ / ❌).
3. **Field names match the UI exactly.** Use the label a user actually sees.
4. **Provider examples go in `<details>` blocks** - Gmail, MinIO, Synology, and similar external setups.
5. **No comparison tables in individual guides.** Comparisons belong on the category index page.
6. **No "Best Practices" laundry lists.** Fold tips into `::: tip` callouts where they are relevant, or drop them.
7. **Max 5 troubleshooting entries.** Cover errors users actually hit.
8. **100-200 lines per guide.** Past 250 lines, something needs cutting or splitting.

## Index pages

Each category (sources, destinations, notifications) has an index page with a table of all adapters and links, a brief "Choosing" section, shared setup steps if any, and links to the individual guides.

## VitePress features

```markdown
::: tip Title
::: warning Title
::: danger Title
::: info Title
```

`::: code-group` for multi-variant code blocks. `<details>/<summary>` for optional or collapsible content.

## Content principles

- **Verify every claim against the code.** Config fields, defaults, and feature claims must match `src/lib/adapters/definitions/` and the adapter implementation. Do not document a field that does not exist.
- **Do not document external products.** Link to official docs instead of explaining Gmail, AWS IAM, or Nginx.
- **One source of truth.** Link rather than repeat.
- **Screenshots are optional.** Only when the UI flow is genuinely confusing.

---

# Part 2 - Changelog format (`docs/changelog.md`)

## What never gets an entry

This file is published on the docs site for people who run DBackup. AI tooling is invisible to them and stays out:

- `CLAUDE.md` files anywhere in the tree
- `.claude/` in full - agents, skills, commands, settings, launch config
- `.gitignore` rules that only exist to track those files

Code that ships in the repository still counts even when its purpose is to keep the assistant honest. A lint guard under `tests/` changes the build for every contributor and belongs in `### 🧪 Tests`.

## Entry format

```
- **component**: Description of the change ([#N](url))
```

**component** - short, lowercase area or adapter name (`auth`, `MSSQL`, `dashboard`, `ui`, `backup`, `storage`, `SSO`, `Redis`). Always a single name, never a sentence, never two areas joined:

- ✅ `**storage**: ...`  ❌ `**storage alerts**: ...`
- ✅ `**Valkey**: ...`  ❌ `**new Valkey adapter**: ...` (the "what happened" belongs in the description)

**Description** - one sentence, as short as it can be while still making sense. Two only if unavoidable. Write **what** changed, not why or how. No file paths, function names, or internals.

**Issue links** - always at the end as `([#N](url))`. Never inside the component name.

**One entry per user-visible change.** A PR touching 20 files to deliver one behavior change is one line. Two unrelated changes in one PR are two lines.

## Section order

Never rearrange. Omit sections with no entries.

| # | Section | Use for |
| :--- | :--- | :--- |
| 1 | `### ✨ Features` | New features, adapters, capabilities |
| 2 | `### 🐛 Bug Fixes` | Bug fixes |
| 3 | `### 🔒 Security` | Security-related changes |
| 4 | `### 🎨 Improvements` | Performance, UX, quality |
| 5 | `### 🔄 Changed` | Changed behavior (non-breaking) |
| 6 | `### 🗑️ Removed` | Removed features, deprecated code |
| 7 | `### 📝 Documentation` | Documentation changes |
| 8 | `### 🧪 Tests` | Tests added or changed |
| 9 | `### 🔧 CI/CD` | Pipeline changes |
| 10 | `### 🐳 Docker` | Docker image info (always last) |

Do not invent new sections.

## Version header

```markdown
## vX.Y.Z - Short Title
*Released: Month Day, Year*
```

Unreleased versions use `*Release: In Progress*`. `pnpm changelog:next` creates a `## vNEXT` placeholder.

## Breaking changes

A blockquote directly below the release date, before any section:

```markdown
> ⚠️ **Breaking:** What breaks and how to migrate.
```

## Docker section

Last section of every version with a published image:

```markdown
### 🐳 Docker

- **Image**: `skyfay/dbackup:vX.Y.Z`
- **Also tagged as**: `latest`, `v1`
- **Platforms**: linux/amd64, linux/arm64
```

Tag rules: stable releases get `latest` plus the major tag (`v1`), `-beta` releases get `beta`, `-dev` releases get `dev`.

## Additional rules

- Newest version at the top.
- No `---` separators between versions. VitePress renders them.
- Entries are grouped under `###` headings, never a flat list.

## Example

```markdown
## v1.2.0 - Cloud Storage & Notifications
*Released: April 15, 2026*

### ✨ Features

- **Google Drive**: Added OAuth 2.0 integration with folder browser
- **email**: Added multi-recipient support via tag input

### 🔒 Security

- **OAuth**: Refresh tokens are now encrypted at rest

### 🎨 Improvements

- **dashboard**: Reduced storage statistics page load time

### 🐛 Bug Fixes

- **auth**: Fixed blank page shown to SSO users after login redirect

### 📝 Documentation

- **wiki**: Added per-provider setup guides for cloud storage adapters

### 🐳 Docker

- **Image**: `skyfay/dbackup:v1.2.0`
- **Also tagged as**: `latest`, `v1`
- **Platforms**: linux/amd64, linux/arm64
```
