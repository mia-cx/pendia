<script lang="ts">
import type { Snippet } from "svelte";
import { client } from "$lib/api.ts";
import {
  artworkUrl,
  episodeCode,
  formatBytes,
  formatDuration,
  type ItemDetail,
  itemHref,
} from "$lib/browse.ts";
import Failure from "$lib/components/Failure.svelte";
import Artwork from "$lib/components/Artwork.svelte";
import PosterCard from "$lib/components/PosterCard.svelte";
import StoreRequest from "$lib/components/StoreRequest.svelte";
import { resource } from "$lib/resource.svelte.ts";

const {
  id,
  actions,
}: {
  id: string;
  /** Controls such as Play, drawn under the title. */
  actions?: Snippet<[ItemDetail]>;
} = $props();

const item = resource(() => client.items.get({ id }));

const castPreview = 12;
const backdropWidths = [960, 1440, 1920, 2560];

let wholeCast = $state(false);

const count = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

function facts(detail: ItemDetail): string[] {
  const runtime = detail.versions[0]?.durationSeconds;
  return [
    detail.kind === "episode" ? episodeCode(detail) : null,
    detail.year === null ? null : String(detail.year),
    detail.contentRating,
    runtime == null ? null : formatDuration(runtime),
    detail.kind === "show"
      ? count(detail.children.length, "season", "seasons")
      : null,
    detail.kind === "season"
      ? count(detail.children.length, "episode", "episodes")
      : null,
    detail.genres.length === 0 ? null : detail.genres.join(", "),
  ].filter((fact) => fact !== null);
}

const seasonLabel = (seasonNumber: number | null) =>
  seasonNumber === 0 ? "Specials" : `Season ${seasonNumber}`;

const titleCase = (role: string) =>
  role.charAt(0).toUpperCase() + role.slice(1);
</script>

<svelte:head>
  <title>{item.data ? `${item.data.title} · Pendia` : "Pendia"}</title>
</svelte:head>

<div class="legacy">
{#if item.failure}
  <Failure failure={item.failure} />
{:else if item.data}
  {@const detail = item.data}
  {@const cast = detail.credits.filter((credit) => credit.role === "actor")}
  {@const crew = detail.credits.filter((credit) => credit.role !== "actor")}
  <article>
    {#if detail.backdropArtworkId}
      <div class="backdrop">
        <img
          src={artworkUrl(detail.backdropArtworkId, 1440)}
          srcset={backdropWidths
            .map(
              (width) =>
                `${artworkUrl(detail.backdropArtworkId ?? "", width)} ${width}w`,
            )
            .join(", ")}
          sizes="100vw"
          alt=""
        />
      </div>
    {/if}

    <div class="head" class:over={detail.backdropArtworkId !== null}>
      <div class="poster">
        <Artwork
          artworkId={detail.posterArtworkId ??
            detail.show?.posterArtworkId ??
            null}
          title={detail.title}
          kind={detail.kind}
          caption={detail.year === null ? null : String(detail.year)}
          sizes="(max-width: 640px) 120px, 220px"
          loading="eager"
        />
      </div>
      <div class="info">
        {#if detail.show}
          <nav aria-label="Breadcrumb">
            <a href="/shows/{detail.show.id}">{detail.show.title}</a>
            {#if detail.kind === "episode" && detail.parentId}
              <span aria-hidden="true">›</span>
              <a href="/shows/{detail.show.id}/seasons/{detail.parentId}"
                >{seasonLabel(detail.seasonNumber)}</a
              >
            {/if}
          </nav>
        {/if}
        <h1>{detail.title}</h1>
        {#if facts(detail).length > 0}
          <p class="facts">{facts(detail).join(" · ")}</p>
        {/if}
        {#if actions}
          <div class="actions">{@render actions(detail)}</div>
        {/if}
        {#if detail.overview}
          <p class="overview">{detail.overview}</p>
        {/if}
      </div>
    </div>

    {#if detail.kind === "show" && detail.children.length > 0}
      <section aria-labelledby="seasons">
        <h2 id="seasons">Seasons</h2>
        <ul class="poster-grid">
          {#each detail.children as season (season.id)}
            <li><PosterCard card={season} /></li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if detail.kind === "season" && detail.children.length > 0}
      <section aria-labelledby="episodes">
        <h2 id="episodes">Episodes</h2>
        <ol class="episodes">
          {#each detail.children as episode (episode.id)}
            <li>
              <a href={itemHref(episode)}>
                <span class="number">{episode.episodeNumber}</span>
                <span>{episode.title}</span>
              </a>
            </li>
          {/each}
        </ol>
      </section>
    {/if}

    {#if detail.versions.length > 0}
      <section aria-labelledby="versions">
        <h2 id="versions">Versions</h2>
        <ul class="rows">
          {#each detail.versions as version (version.id)}
            <li>
              <span>{version.label}</span>
              <span class="muted">
                {[
                  version.durationSeconds === null
                    ? null
                    : formatDuration(version.durationSeconds),
                  formatBytes(version.bytes),
                ]
                  .filter((part) => part !== null)
                  .join(" · ")}
              </span>
            </li>
          {/each}
        </ul>
        <StoreRequest {detail} />
      </section>
    {/if}

    {#if cast.length > 0}
      <section aria-labelledby="cast">
        <h2 id="cast">Cast</h2>
        <ul class="people">
          {#each wholeCast ? cast : cast.slice(0, castPreview) as credit, index (`${credit.contributorId}-${index}`)}
            <li>
              <span>{credit.name}</span>
              {#if credit.character}
                <span class="muted">{credit.character}</span>
              {/if}
            </li>
          {/each}
        </ul>
        {#if cast.length > castPreview}
          <button
            type="button"
            aria-expanded={wholeCast}
            onclick={() => (wholeCast = !wholeCast)}
            >{wholeCast ? "Show less" : `Show all ${cast.length}`}</button
          >
        {/if}
      </section>
    {/if}

    {#if crew.length > 0}
      <section aria-labelledby="crew">
        <h2 id="crew">Crew</h2>
        <ul class="people">
          {#each crew as credit, index (`${credit.contributorId}-${index}`)}
            <li>
              <span>{credit.name}</span>
              <span class="muted">{titleCase(credit.role)}</span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  </article>
{/if}
</div>

<style>
  .backdrop {
    position: relative;
    height: min(56svh, 42vw);
    margin: -24px calc(-1 * var(--gutter)) 0;
    overflow: hidden;
  }

  .backdrop img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .backdrop::after {
    position: absolute;
    inset: 0;
    background: linear-gradient(to bottom, transparent 40%, var(--canvas));
    content: "";
  }

  .head {
    position: relative;
    display: grid;
    grid-template-columns: 220px minmax(0, 1fr);
    align-items: end;
    gap: 32px;
  }

  .head.over {
    margin-top: -120px;
  }

  .info {
    max-width: 72ch;
  }

  nav {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    color: var(--muted);
  }

  nav a {
    color: var(--ink);
    font-weight: 600;
  }

  h1 {
    margin: 4px 0 8px;
    font-size: clamp(28px, 4vw, 44px);
    letter-spacing: -0.02em;
    overflow-wrap: anywhere;
  }

  .facts {
    margin: 0;
    color: var(--muted);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-top: 16px;
  }

  .overview {
    margin: 16px 0 0;
    text-wrap: pretty;
  }

  section {
    margin-top: 40px;
  }

  h2 {
    margin: 0 0 12px;
  }

  .episodes,
  .rows,
  .people {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .episodes,
  .rows {
    max-width: 720px;
  }

  .episodes a {
    display: flex;
    gap: 16px;
    padding: 10px 0;
    border-bottom: 1px solid var(--line);
    color: var(--ink);
    text-decoration: none;
  }

  .episodes a:hover {
    color: var(--signal);
  }

  .number {
    min-width: 3ch;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .rows li {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 4px 16px;
    padding: 10px 0;
    border-bottom: 1px solid var(--line);
  }

  .people {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 12px 24px;
  }

  .people li {
    display: grid;
  }

  .people + button {
    margin-top: 16px;
  }

  @media (max-width: 640px) {
    .head {
      grid-template-columns: 120px minmax(0, 1fr);
      gap: 16px;
    }

    .head.over {
      margin-top: -48px;
    }

    .info {
      grid-column: 1 / -1;
    }
  }
</style>
