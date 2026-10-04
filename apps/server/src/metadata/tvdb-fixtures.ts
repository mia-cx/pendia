/** A TVDB v4 series extended record for tests, trimmed to the fields Pendia reads. */
export const tvdbSeries = {
  id: 81189,
  name: "Breaking Bad",
  overview: "A chemistry teacher turns to making meth.",
  year: "2008",
  firstAired: "2008-01-20",
  lastAired: "2013-09-29",
  image: "https://artworks.thetvdb.com/banners/posters/81189-1.jpg",
  status: { id: 1, name: "Continuing" },
  genres: [{ name: "Drama" }, { name: "Crime" }, { name: "Drama" }],
  contentRatings: [
    { name: "15", country: "gbr" },
    { name: "TV-MA", country: "usa" },
  ],
  remoteIds: [
    { id: "tt0903747", type: 2, sourceName: "IMDB" },
    { id: "1396", type: 12, sourceName: "TheMovieDB.com" },
  ],
  characters: [
    {
      name: "Jesse Pinkman",
      personName: "Aaron Paul",
      peopleType: "Actor",
      sort: 1,
    },
    {
      name: "Walter White",
      personName: "Bryan Cranston",
      peopleType: "Actor",
      sort: 0,
    },
    { name: null, personName: "Vince Gilligan", peopleType: "Creator" },
    { name: "Unknown", personName: null, peopleType: "Actor", sort: 2 },
  ],
  artworks: [
    {
      type: 2,
      image: "https://artworks.thetvdb.com/banners/posters/81189-1.jpg",
    },
    { type: 3, image: "/banners/fanart/original/81189-1.jpg" },
    { type: 23, image: "https://artworks.thetvdb.com/banners/logos/81189.png" },
    {
      type: 1,
      image: "https://artworks.thetvdb.com/banners/graphical/81189.jpg",
    },
  ],
  seasons: [
    {
      id: 30272,
      number: 1,
      name: null,
      image: "https://artworks.thetvdb.com/banners/seasons/81189-1.jpg",
      type: { type: "official" },
    },
    { id: 28047, number: 2, type: { type: "official" } },
    { id: 32000, number: 0, type: { type: "official" } },
    { id: 99999, number: 1, type: { type: "dvd" } },
  ],
};

/** The official-order Episodes of `tvdbSeries`, split over two pages. */
export const tvdbEpisodePages = [
  [
    {
      id: 349232,
      seasonNumber: 1,
      number: 1,
      name: "Pilot",
      overview: "Walter White begins.",
      aired: "2008-01-20",
      image: "https://artworks.thetvdb.com/banners/episodes/81189/349232.jpg",
    },
    {
      id: 349235,
      seasonNumber: 1,
      number: 2,
      name: "Cat's in the Bag...",
      aired: "2008-01-27",
      image: null,
    },
  ],
  [{ id: 400001, seasonNumber: 2, number: 1, name: null, aired: "" }],
];

/** Answers TVDB v4 requests for `tvdbSeries`; anything else is a 404. */
export function tvdbResponse(url: URL, init?: RequestInit): Response {
  const path = url.pathname.replace(/^\/v4/, "");
  if (path === "/login" && init?.method === "POST")
    return Response.json({ status: "success", data: { token: "tvdb-token" } });
  if (path === "/search") return Response.json({ data: [] });
  if (path === "/series/81189/extended")
    return Response.json({ status: "success", data: tvdbSeries });
  if (path === "/series/81189/episodes/official") {
    const page = Number(url.searchParams.get("page"));
    const next =
      page + 1 < tvdbEpisodePages.length
        ? `https://api4.thetvdb.com/v4/series/81189/episodes/official?page=${page + 1}`
        : null;
    return Response.json({
      status: "success",
      data: { series: { id: 81189 }, episodes: tvdbEpisodePages[page] ?? [] },
      links: { next },
    });
  }
  if (path === "/seasons/30272")
    return Response.json({ data: { id: 30272, seriesId: 81189 } });
  if (path === "/episodes/349232")
    return Response.json({ data: { id: 349232, seriesId: 81189 } });
  return new Response("not found", { status: 404 });
}
