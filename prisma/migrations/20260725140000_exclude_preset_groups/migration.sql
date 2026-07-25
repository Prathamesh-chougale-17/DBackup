-- Let a preset reference curated pattern groups instead of copying their contents.
--
-- The groups themselves live in code (src/lib/exclude-groups.ts). Referencing them is what
-- makes them maintainable: extending a group in a later release reaches every preset that
-- uses it, with no migration and without touching anything the user wrote. A preset can still
-- drop individual patterns from a group, so following a curated list is never all-or-nothing.
ALTER TABLE "ExcludePatternPreset" ADD COLUMN "groups" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "ExcludePatternPreset" ADD COLUMN "excludedGroupPatterns" TEXT NOT NULL DEFAULT '[]';

-- Move the built-in preset onto the groups it was hand-seeded from, so future releases can
-- extend those lists for it too. Its own patterns become empty - everything it had is covered
-- by the macos and windows groups.
--
-- Guarded on the exact patterns this project shipped: an installation where someone already
-- edited the preset keeps their version untouched rather than having it silently replaced.
UPDATE "ExcludePatternPreset"
SET "groups" = '["macos","windows"]',
    "patterns" = '[]',
    "description" = 'Operating system clutter that no backup needs. Follows the curated macOS and Windows lists, which stay up to date with each release.',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'exclude-system-junk'
  AND "patterns" = '[".DS_Store","._*",".Spotlight-V100",".Trashes","Thumbs.db","ehthumbs.db","desktop.ini"]';
