/**
 * The hosted-dataset manifest (`data/datasets.json`). It is the site owner's own file, but a typo
 * there should hide one entry with a warning rather than break the picker or crash the app, so
 * every entry is checked for its three required string fields before it is used.
 */
import type { AlignmentState } from '../state/viewerState';

export interface ManifestEntry {
  id: string;
  name: string;
  description?: string;
  url: string;
  size_bytes?: number;
  spatial_key?: string;
  library_key?: string;
  default_color_by?: { type: string; key: string };
  default_tooltip_fields?: string[];
  example_genes?: string[];
  /** per-section manual alignment applied by default (file units / degrees), keyed by section name */
  section_alignment?: Record<string, Partial<AlignmentState>>;
}

/**
 * Entries of a parsed manifest that carry a non-empty `id`, a `name` and a non-empty `url`, plus
 * the number that were dropped. Throws when `datasets` is missing or not a list.
 */
export function manifestEntries(json: unknown): { entries: ManifestEntry[]; skipped: number } {
  const list =
    json !== null && typeof json === 'object'
      ? (json as { datasets?: unknown }).datasets
      : undefined;
  if (!Array.isArray(list)) throw new Error('"datasets" is not a list');
  const entries = list.filter(isEntry);
  return { entries, skipped: list.length - entries.length };
}

function isEntry(d: unknown): d is ManifestEntry {
  if (d === null || typeof d !== 'object') return false;
  const e = d as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    e.id !== '' &&
    typeof e.name === 'string' &&
    typeof e.url === 'string' &&
    e.url !== ''
  );
}
