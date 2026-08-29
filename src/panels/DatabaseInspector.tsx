import { useEffect, useState } from 'react'
import { DataRow, SectionHeader } from '../ui/DataRow'
import { useWsEvent } from '../hooks/useWs'
import { formatBytes } from './format'
import { SERVER_HOST } from '../config/serverHost'

const API = `http://${SERVER_HOST}:8899/api/v1`

/* The Database Inspector — the operational/engineering counterpart to
 * CollectionPanel.tsx's OverviewBlock. That block answers "what's in my
 * collection" from /stats (a curatorial view); this answers "is the
 * pipeline healthy and what does the raw schema actually hold" from
 * /db-inspector — the numbers Daniel currently has to open `sqlite3` by
 * hand to see. Mounted by App.tsx into InspectorPanel's 'database' rail
 * destination. Every value renders in mono ink via DataRow — this is all
 * data about the library, not control chrome, so DESIGN.md's "one rule"
 * applies with no Rubik-control exception. */

type LatestScan = {
  id: number
  status: string
  filesScanned: number
  filesAdded: number
  filesUpdated: number
  filesMissing: number
  startedAt: string
  finishedAt: string | null
} | null

type DbInspectorSnapshot = {
  pipeline: {
    latestScan: LatestScan
    enrichJobs: { status: string; count: number }[]
  }
  matchQuality: { source: string; count: number; share: number }[]
  schema: {
    nodesByType: { type: string; count: number }[]
    edgesByType: { type: string; count: number }[]
    files: number
    plays: number
    articles: number
    fieldProvenance: number
    coverArt: number
    mergeOverrides: number
    tagWrites: number
  }
  storage: {
    dbBytes: number
    coverCache: { fileCount: number; totalBytes: number }
  }
}

function PipelineSection({ pipeline }: { pipeline: DbInspectorSnapshot['pipeline'] }) {
  const { latestScan, enrichJobs } = pipeline
  return (
    <>
      <SectionHeader title="pipeline" />
      <div className="mt-[8px]">
        {latestScan ? (
          <>
            <DataRow label="latest scan" value={latestScan.status} />
            <DataRow label="scanned" value={latestScan.filesScanned.toLocaleString()} />
            <DataRow label="added" value={latestScan.filesAdded.toLocaleString()} />
            <DataRow label="updated" value={latestScan.filesUpdated.toLocaleString()} />
            <DataRow label="missing" value={latestScan.filesMissing.toLocaleString()} />
            <DataRow label="started" value={latestScan.startedAt} />
            <DataRow label="finished" value={latestScan.finishedAt ?? 'in progress'} />
          </>
        ) : (
          <DataRow label="latest scan" value="none yet" />
        )}
        {enrichJobs.map((job) => (
          <DataRow key={job.status} label={`enrich: ${job.status}`} value={job.count.toLocaleString()} />
        ))}
      </div>
    </>
  )
}

function MatchQualitySection({ matchQuality }: { matchQuality: DbInspectorSnapshot['matchQuality'] }) {
  return (
    <>
      <SectionHeader title="match quality" />
      <div className="mt-[8px]">
        {matchQuality.length === 0 ? (
          <DataRow label="tracks" value="none scanned yet" />
        ) : (
          matchQuality.map((row) => (
            <DataRow key={row.source} label={row.source} value={`${row.count.toLocaleString()} (${Math.round(row.share * 100)}%)`} />
          ))
        )}
      </div>
    </>
  )
}

function SchemaSection({ schema }: { schema: DbInspectorSnapshot['schema'] }) {
  return (
    <>
      <SectionHeader title="schema" />
      <div className="mt-[8px]">
        {schema.nodesByType.map((row) => (
          <DataRow key={`node-${row.type}`} label={`nodes: ${row.type}`} value={row.count.toLocaleString()} />
        ))}
        {schema.edgesByType.map((row) => (
          <DataRow key={`edge-${row.type}`} label={`edges: ${row.type}`} value={row.count.toLocaleString()} />
        ))}
        <DataRow label="files" value={schema.files.toLocaleString()} />
        <DataRow label="plays" value={schema.plays.toLocaleString()} />
        <DataRow label="articles" value={schema.articles.toLocaleString()} />
        <DataRow label="field provenance" value={schema.fieldProvenance.toLocaleString()} />
        <DataRow label="cover art" value={schema.coverArt.toLocaleString()} />
        <DataRow label="merge overrides" value={schema.mergeOverrides.toLocaleString()} />
        <DataRow label="tag writes" value={schema.tagWrites.toLocaleString()} />
      </div>
    </>
  )
}

function StorageSection({ storage }: { storage: DbInspectorSnapshot['storage'] }) {
  return (
    <>
      <SectionHeader title="storage" />
      <div className="mt-[8px]">
        <DataRow label="database" value={formatBytes(storage.dbBytes)} />
        <DataRow label="cover cache" value={`${formatBytes(storage.coverCache.totalBytes)} (${storage.coverCache.fileCount.toLocaleString()} files)`} />
      </div>
    </>
  )
}

export function DatabaseInspector() {
  const [snapshot, setSnapshot] = useState<DbInspectorSnapshot | null>(null)

  const load = () => {
    fetch(`${API}/db-inspector`)
      .then((r) => r.json())
      .then(setSnapshot)
      .catch(() => setSnapshot(null))
  }

  useEffect(load, [])
  // A snapshot/aggregate view, not a single-entity subscription — any event
  // that can move these counts is worth a cheap refetch rather than a new
  // dedicated event.
  useWsEvent(['scan:done', 'scan:file', 'hygiene:changed', 'tag-write:written'], load)

  if (snapshot === null) return <p className="text-[length:var(--text-base)] text-[var(--color-muted)]">loading…</p>

  return (
    <div className="flex flex-col">
      <PipelineSection pipeline={snapshot.pipeline} />
      <MatchQualitySection matchQuality={snapshot.matchQuality} />
      <SchemaSection schema={snapshot.schema} />
      <StorageSection storage={snapshot.storage} />
    </div>
  )
}
