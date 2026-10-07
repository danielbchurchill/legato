import { DataRow, SectionHeader } from '../ui/DataRow'
import { formatBytes } from './format'

/* The database inspector's internals — the scan pipeline, the raw schema
 * counts, storage — kept as the "under the hood" disclosure at the foot of
 * Library health (HealthPanel.tsx). Everything a person acts on moved up
 * into Health itself; these are the numbers someone debugging the pipeline
 * would otherwise open sqlite3 for. Mono ink values through DataRow: it's
 * all data about the library. */

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

export type DbInspectorSnapshot = {
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

export function PipelineSection({ pipeline }: { pipeline: DbInspectorSnapshot['pipeline'] }) {
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

export function SchemaSection({ schema }: { schema: DbInspectorSnapshot['schema'] }) {
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

export function StorageSection({ storage }: { storage: DbInspectorSnapshot['storage'] }) {
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
