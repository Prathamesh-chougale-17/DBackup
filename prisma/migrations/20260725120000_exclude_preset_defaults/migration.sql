-- Let exclude pattern presets be marked as a default, and ship one for junk files.
--
-- Unlike a naming template, several presets may be default at once: they are unioned, so
-- "system junk" and "node_modules" can both apply to a new source without conflicting.
ALTER TABLE "ExcludePatternPreset" ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false;

-- Seed: files the operating system writes into every folder and that no backup wants.
--
-- Marked as default so newly added directory sources pick it up, and as a system preset so it
-- cannot be deleted - its patterns stay editable. Existing job sources are untouched: they
-- keep whatever they were configured with, so no backup silently starts excluding files.
--
-- Dropbox refuses `.DS_Store` outright (path/disallowed_name), so restoring a macOS-sourced
-- backup there fails on that file unless it was never collected in the first place.
INSERT OR IGNORE INTO "ExcludePatternPreset" ("id", "name", "description", "patterns", "isDefault", "isSystem", "createdAt", "updatedAt")
VALUES (
  'exclude-system-junk',
  'System Junk Files',
  'Operating system clutter that no backup needs: macOS .DS_Store, Windows Thumbs.db and desktop.ini.',
  '[".DS_Store","._*",".Spotlight-V100",".Trashes","Thumbs.db","ehthumbs.db","desktop.ini"]',
  true,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);
