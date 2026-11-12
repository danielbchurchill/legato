-- Issue #323: recompute() used to derive every file's local edges
-- (match/edges.ts's deriveLocalEdges) on every run, whether or not anything
-- it reads had changed: 53 s of a 136 s recompute at 30,000 albums. It now
-- derives the files these triggers queue, and every file once whenever the
-- rules themselves change (match/localEdgeRules.ts, local_edges_rules below).
--
-- A file's local edges are worked out from its own row, from its album
-- folder's other present files (match/albumIdentity.ts decides an album over
-- the whole folder), from the evidence enrichment keeps about its recording,
-- and from which artist node a name finds. The triggers queue the path of
-- every file whose edges any of those changes can move. recompute derives
-- every present file in the album folder of each queued path, so a file's
-- neighbours are derived with it, a moved file's old and new folders both
-- are, and so is the folder a missing file left.
--
-- One row per path, so a busy scan can't grow the queue past the library.
-- Queuing a path again deletes its row and inserts it afresh, with an id
-- larger than any id before it (AUTOINCREMENT never reuses one). recompute
-- reads the queue when it starts and deletes only the ids it read, once
-- every file they asked for has been derived and committed: a path queued
-- again while it runs keeps its new row for the next run, and a run that
-- stops partway leaves its rows for the next one. Not INSERT OR REPLACE:
-- a trigger's conflict clause gives way to the statement that fired it, and
-- match/people.ts's merges run UPDATE OR IGNORE, which would keep the old id.
CREATE TABLE local_edges_pending (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL UNIQUE
);

-- The hash of the rules local edges were last derived with for every file
-- (match/localEdgeRules.ts), written only once such a full pass has
-- committed. NULL until then, so the first recompute after this migration
-- derives every file, as every recompute did before it. Not in `settings`,
-- for member_bound_prune's reason (0043): PUT /settings writes any key.
CREATE TABLE local_edges_rules (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  hash TEXT
);

INSERT INTO local_edges_rules (id) VALUES (1);

-- A file's own row: a new file, new tags, a new path, the recording collapse
-- moved it to, its disc and track numbers, and going missing or coming back.
-- Its old path too, when that changed, for the folder it left. An UPDATE
-- that leaves all of these as they were, as a re-scan's last_seen_at does,
-- queues nothing.
CREATE TRIGGER files_queue_local_edges_insert AFTER INSERT ON files
BEGIN
  DELETE FROM local_edges_pending WHERE file_path = NEW.file_path;
  INSERT INTO local_edges_pending (file_path) VALUES (NEW.file_path);
END;

CREATE TRIGGER files_queue_local_edges_update
AFTER UPDATE OF recording_node_id, file_path, disc_no, track_no, tags_raw, missing_since ON files
WHEN OLD.recording_node_id IS NOT NEW.recording_node_id
  OR OLD.file_path IS NOT NEW.file_path
  OR OLD.disc_no IS NOT NEW.disc_no
  OR OLD.track_no IS NOT NEW.track_no
  OR OLD.tags_raw IS NOT NEW.tags_raw
  OR OLD.missing_since IS NOT NEW.missing_since
BEGIN
  DELETE FROM local_edges_pending WHERE file_path IN (NEW.file_path, OLD.file_path);
  INSERT INTO local_edges_pending (file_path) VALUES (NEW.file_path);
  INSERT INTO local_edges_pending (file_path) SELECT OLD.file_path WHERE OLD.file_path IS NOT NEW.file_path;
END;

-- Removing a library folder deletes its files (library-roots.ts). Its album
-- folders are usually its own, but a root nested in another can share one.
CREATE TRIGGER files_queue_local_edges_delete AFTER DELETE ON files
BEGIN
  DELETE FROM local_edges_pending WHERE file_path = OLD.file_path;
  INSERT INTO local_edges_pending (file_path) VALUES (OLD.file_path);
END;

-- The keys an album node is found by (match/releases.ts). Deriving a file
-- adds them; undoing an album's rename (tagwrite/rename.ts) takes back the
-- ones it added, which can send a file on that album to another node.
CREATE TRIGGER release_keys_queue_local_edges_delete AFTER DELETE ON release_keys
BEGIN
  DELETE FROM local_edges_pending WHERE file_path IN
    (SELECT f.file_path FROM edges e JOIN files f ON f.recording_node_id = e.from_node
      WHERE e.to_node = OLD.node_id AND e.type = 'appears_on' AND e.source = 'local' AND f.missing_since IS NULL);
  INSERT INTO local_edges_pending (file_path)
    SELECT DISTINCT f.file_path FROM edges e JOIN files f ON f.recording_node_id = e.from_node
      WHERE e.to_node = OLD.node_id AND e.type = 'appears_on' AND e.source = 'local' AND f.missing_since IS NULL;
END;

-- Evidence (match/evidence.ts): the people MusicBrainz's relations credit on
-- a recording, by their nodes' titles, are what split its producer and
-- engineer lines, and its artist credit splits its performer line. Each
-- change to either queues the recording's present files.
CREATE TRIGGER edges_queue_local_edges_insert AFTER INSERT ON edges WHEN NEW.source = 'musicbrainz'
BEGIN
  DELETE FROM local_edges_pending WHERE file_path IN
    (SELECT file_path FROM files WHERE recording_node_id = NEW.from_node AND missing_since IS NULL);
  INSERT INTO local_edges_pending (file_path)
    SELECT file_path FROM files WHERE recording_node_id = NEW.from_node AND missing_since IS NULL;
END;

CREATE TRIGGER edges_queue_local_edges_delete AFTER DELETE ON edges WHEN OLD.source = 'musicbrainz'
BEGIN
  DELETE FROM local_edges_pending WHERE file_path IN
    (SELECT file_path FROM files WHERE recording_node_id = OLD.from_node AND missing_since IS NULL);
  INSERT INTO local_edges_pending (file_path)
    SELECT file_path FROM files WHERE recording_node_id = OLD.from_node AND missing_since IS NULL;
END;

-- A merge (match/people.ts) moves an edge to the node that survives it,
-- whose title may differ.
CREATE TRIGGER edges_queue_local_edges_update AFTER UPDATE OF from_node, to_node, source ON edges
WHEN (OLD.source = 'musicbrainz' OR NEW.source = 'musicbrainz')
  AND (OLD.from_node IS NOT NEW.from_node OR OLD.to_node IS NOT NEW.to_node OR OLD.source IS NOT NEW.source)
BEGIN
  DELETE FROM local_edges_pending WHERE file_path IN
    (SELECT file_path FROM files WHERE recording_node_id IN (OLD.from_node, NEW.from_node) AND missing_since IS NULL);
  INSERT INTO local_edges_pending (file_path)
    SELECT file_path FROM files WHERE recording_node_id IN (OLD.from_node, NEW.from_node) AND missing_since IS NULL;
END;

-- A node a MusicBrainz relation credits, renamed.
CREATE TRIGGER nodes_queue_local_edges_credited_title AFTER UPDATE OF title ON nodes
WHEN NEW.type IN ('artist', 'credit') AND OLD.title IS NOT NEW.title
BEGIN
  DELETE FROM local_edges_pending WHERE file_path IN
    (SELECT f.file_path FROM edges e JOIN files f ON f.recording_node_id = e.from_node
      WHERE e.to_node = NEW.id AND e.source = 'musicbrainz' AND f.missing_since IS NULL);
  INSERT INTO local_edges_pending (file_path)
    SELECT DISTINCT f.file_path FROM edges e JOIN files f ON f.recording_node_id = e.from_node
      WHERE e.to_node = NEW.id AND e.source = 'musicbrainz' AND f.missing_since IS NULL;
END;

CREATE TRIGGER field_provenance_queue_local_edges_insert AFTER INSERT ON field_provenance
WHEN NEW.field = 'artist_credit'
BEGIN
  DELETE FROM local_edges_pending WHERE file_path IN
    (SELECT file_path FROM files WHERE recording_node_id = NEW.node_id AND missing_since IS NULL);
  INSERT INTO local_edges_pending (file_path)
    SELECT file_path FROM files WHERE recording_node_id = NEW.node_id AND missing_since IS NULL;
END;

CREATE TRIGGER field_provenance_queue_local_edges_delete AFTER DELETE ON field_provenance
WHEN OLD.field = 'artist_credit'
BEGIN
  DELETE FROM local_edges_pending WHERE file_path IN
    (SELECT file_path FROM files WHERE recording_node_id = OLD.node_id AND missing_since IS NULL);
  INSERT INTO local_edges_pending (file_path)
    SELECT file_path FROM files WHERE recording_node_id = OLD.node_id AND missing_since IS NULL;
END;

CREATE TRIGGER field_provenance_queue_local_edges_update AFTER UPDATE OF node_id, field, value ON field_provenance
WHEN OLD.field = 'artist_credit' OR NEW.field = 'artist_credit'
BEGIN
  DELETE FROM local_edges_pending WHERE file_path IN
    (SELECT file_path FROM files WHERE recording_node_id IN (OLD.node_id, NEW.node_id) AND missing_since IS NULL);
  INSERT INTO local_edges_pending (file_path)
    SELECT file_path FROM files WHERE recording_node_id IN (OLD.node_id, NEW.node_id) AND missing_since IS NULL;
END;

-- Which artist node a name finds (match/artistLookup.ts): case, outer spaces
-- and a leading "The" aside, the node with the same name exactly, or the one
-- whose MusicBrainz id the file's tag names. So a name's files can move when
-- another node of that name appears, becomes an artist (findOrCreatePerson
-- retypes a credit), is renamed, or gains a MusicBrainz id. Each queues the
-- files whose person edges point at the other nodes of its name, if there
-- are any: a name only one node has, the usual case, queues nothing. The
-- name's key is artistLookup.ts's artistNameKey, worked out the way SQLite's
-- lower(trim()) does it, which artistNameKey mirrors (artistLookup.ts) and
-- localEdgesQueue.spec.ts checks.
CREATE TRIGGER nodes_queue_local_edges_artist_insert AFTER INSERT ON nodes WHEN NEW.type = 'artist'
BEGIN
  DELETE FROM local_edges_pending WHERE file_path IN
    (SELECT f.file_path FROM nodes v
       JOIN edges e ON e.to_node = v.id AND e.source = 'local'
        AND e.type IN ('performed_by', 'featured_artist', 'produced_by', 'engineered_by')
       JOIN files f ON f.recording_node_id = e.from_node AND f.missing_since IS NULL
      WHERE v.type IN ('artist', 'credit') AND v.id != NEW.id
        AND lower(trim(v.title)) IN (
          CASE WHEN substr(lower(trim(NEW.title)), 1, 4) = 'the ' THEN substr(lower(trim(NEW.title)), 5) ELSE lower(trim(NEW.title)) END,
          'the ' || CASE WHEN substr(lower(trim(NEW.title)), 1, 4) = 'the ' THEN substr(lower(trim(NEW.title)), 5) ELSE lower(trim(NEW.title)) END));
  INSERT INTO local_edges_pending (file_path)
    SELECT DISTINCT f.file_path FROM nodes v
       JOIN edges e ON e.to_node = v.id AND e.source = 'local'
        AND e.type IN ('performed_by', 'featured_artist', 'produced_by', 'engineered_by')
       JOIN files f ON f.recording_node_id = e.from_node AND f.missing_since IS NULL
      WHERE v.type IN ('artist', 'credit') AND v.id != NEW.id
        AND lower(trim(v.title)) IN (
          CASE WHEN substr(lower(trim(NEW.title)), 1, 4) = 'the ' THEN substr(lower(trim(NEW.title)), 5) ELSE lower(trim(NEW.title)) END,
          'the ' || CASE WHEN substr(lower(trim(NEW.title)), 1, 4) = 'the ' THEN substr(lower(trim(NEW.title)), 5) ELSE lower(trim(NEW.title)) END);
END;

CREATE TRIGGER nodes_queue_local_edges_artist_update AFTER UPDATE OF type, title ON nodes
WHEN NEW.type = 'artist' AND (OLD.type IS NOT NEW.type OR OLD.title IS NOT NEW.title)
BEGIN
  DELETE FROM local_edges_pending WHERE file_path IN
    (SELECT f.file_path FROM nodes v
       JOIN edges e ON e.to_node = v.id AND e.source = 'local'
        AND e.type IN ('performed_by', 'featured_artist', 'produced_by', 'engineered_by')
       JOIN files f ON f.recording_node_id = e.from_node AND f.missing_since IS NULL
      WHERE v.type IN ('artist', 'credit') AND v.id != NEW.id
        AND lower(trim(v.title)) IN (
          CASE WHEN substr(lower(trim(NEW.title)), 1, 4) = 'the ' THEN substr(lower(trim(NEW.title)), 5) ELSE lower(trim(NEW.title)) END,
          'the ' || CASE WHEN substr(lower(trim(NEW.title)), 1, 4) = 'the ' THEN substr(lower(trim(NEW.title)), 5) ELSE lower(trim(NEW.title)) END));
  INSERT INTO local_edges_pending (file_path)
    SELECT DISTINCT f.file_path FROM nodes v
       JOIN edges e ON e.to_node = v.id AND e.source = 'local'
        AND e.type IN ('performed_by', 'featured_artist', 'produced_by', 'engineered_by')
       JOIN files f ON f.recording_node_id = e.from_node AND f.missing_since IS NULL
      WHERE v.type IN ('artist', 'credit') AND v.id != NEW.id
        AND lower(trim(v.title)) IN (
          CASE WHEN substr(lower(trim(NEW.title)), 1, 4) = 'the ' THEN substr(lower(trim(NEW.title)), 5) ELSE lower(trim(NEW.title)) END,
          'the ' || CASE WHEN substr(lower(trim(NEW.title)), 1, 4) = 'the ' THEN substr(lower(trim(NEW.title)), 5) ELSE lower(trim(NEW.title)) END);
END;

-- A MusicBrainz id only decides between nodes of one name, so this queues
-- the files of every node of the name, the one that gained it included, and
-- only when there's more than one.
CREATE TRIGGER field_provenance_queue_local_edges_artist_mbid AFTER INSERT ON field_provenance
WHEN NEW.field = 'artist_mbid'
  AND (SELECT COUNT(*) FROM nodes v, nodes n
        WHERE n.id = NEW.node_id AND v.type IN ('artist', 'credit')
          AND lower(trim(v.title)) IN (
            CASE WHEN substr(lower(trim(n.title)), 1, 4) = 'the ' THEN substr(lower(trim(n.title)), 5) ELSE lower(trim(n.title)) END,
            'the ' || CASE WHEN substr(lower(trim(n.title)), 1, 4) = 'the ' THEN substr(lower(trim(n.title)), 5) ELSE lower(trim(n.title)) END)) > 1
BEGIN
  DELETE FROM local_edges_pending WHERE file_path IN
    (SELECT f.file_path FROM nodes n, nodes v
       JOIN edges e ON e.to_node = v.id AND e.source = 'local'
        AND e.type IN ('performed_by', 'featured_artist', 'produced_by', 'engineered_by')
       JOIN files f ON f.recording_node_id = e.from_node AND f.missing_since IS NULL
      WHERE n.id = NEW.node_id AND v.type IN ('artist', 'credit')
        AND lower(trim(v.title)) IN (
          CASE WHEN substr(lower(trim(n.title)), 1, 4) = 'the ' THEN substr(lower(trim(n.title)), 5) ELSE lower(trim(n.title)) END,
          'the ' || CASE WHEN substr(lower(trim(n.title)), 1, 4) = 'the ' THEN substr(lower(trim(n.title)), 5) ELSE lower(trim(n.title)) END));
  INSERT INTO local_edges_pending (file_path)
    SELECT DISTINCT f.file_path FROM nodes n, nodes v
       JOIN edges e ON e.to_node = v.id AND e.source = 'local'
        AND e.type IN ('performed_by', 'featured_artist', 'produced_by', 'engineered_by')
       JOIN files f ON f.recording_node_id = e.from_node AND f.missing_since IS NULL
      WHERE n.id = NEW.node_id AND v.type IN ('artist', 'credit')
        AND lower(trim(v.title)) IN (
          CASE WHEN substr(lower(trim(n.title)), 1, 4) = 'the ' THEN substr(lower(trim(n.title)), 5) ELSE lower(trim(n.title)) END,
          'the ' || CASE WHEN substr(lower(trim(n.title)), 1, 4) = 'the ' THEN substr(lower(trim(n.title)), 5) ELSE lower(trim(n.title)) END);
END;
