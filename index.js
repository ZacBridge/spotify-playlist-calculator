const fs = require("fs");
const axios = require("axios");

const mongo = require("mongodb").MongoClient;
const assert = require("assert");

const url = "mongodb://localhost:27017";
const database = "songs";

const spotifyPlaylistUrl = "https://api.spotify.com/v1/playlists/";
const playlistUrl = "22An1WG4qjNFbZtF5yvREF";

mongo.connect(url, async function (err, client) {
  await assert.equal(null, err);
  console.log("Connected successfully to server");

  const db = await client.db(database);

  await process(db);

  client.close();
});

const snooze = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const generateSpotifyPlaylistsTracks = async (getUrl) => {
  let spotifyOptions = {
    Authorization: `Bearer BQCmkkZLjoTnoZG9FTiLfWgm9az2d0ZkLVZC02SW8-ERnW-xrR60eFCG9zHRcEM-bXoysPPvnB1NFjbe4Rs`,
  };

  let tracks = null;

  console.log("getting data");
  let data = await axios.get(getUrl, { headers: spotifyOptions });

  if (data.data) {
    tracks = data.data.items;
  }

  while (true) {
    console.log("ITERATING...");
    if (data.data.next) {
      data = await axios.get(data.data.next, { headers: spotifyOptions });

      if (data.data) {
        tracks.push(data.data.items);
      }

      console.log("GETTING NEXT");
    }

    if (!data.data.next) {
      break;
    }
  }

  console.log("TRACKS COUNT", tracks.length);

  let flattenedTracks = [].concat(...tracks);

  console.log(flattenedTracks);

  return flattenedTracks;
};

const process = async (db) => {
  let total = 0;

  let spotifyPlaylist = await generateSpotifyPlaylistsTracks(
    `${spotifyPlaylistUrl}${playlistUrl}/tracks`
  );

  let counter = 0;
  let tracks = spotifyPlaylist;

  console.log("TRACKS", tracks);

  for await (i of tracks) {
    let item = i.track;

    console.log(`GETTING DATA FOR ${item.name} - ${item.artists[0].name}`);

    //Check if it exists in database first
    let currentTrack = await db
      .collection("songs")
      .findOne({ name: item.name });

    if (currentTrack) {
      console.log("FOUND TRACK IN DB - CHECKING PRICE");
      if (currentTrack.hasOwnProperty("trackPrice")) {
        console.log("HAS PRICE - CHECKING AMOUNT");
        if (currentTrack.trackPrice > 0) {
          console.log(
            "ALREADY HAS TRACK PRICE - ADDING:",
            currentTrack.trackPrice
          );
          total += currentTrack.trackPrice;
          console.log("CURRENT TOTAL PRICE", total);
          continue;
        }
      }
    }

    //Check if already have price for item
    //Dont need to increase counter as not hitting iTunes rate limiter
    if (item.hasOwnProperty("trackPrice")) {
      console.log("ALREADY HAS TRACK PRICE - ADDING:", item.trackPrice);
      total += trackPrice;
      continue;
    }

    //Start with just searching for song
    let song = await getITunesSearchSong(1, item);

    const trackPrice = calculateTrackPrice(song);

    if (song) {
      console.log("FOUND SONG - ADDING PRICE");

      // Calculate and add track price
      console.log("TRACK PRICE", trackPrice);

      item.trackPrice = trackPrice;
      total += trackPrice;

      if (currentTrack) {
        //We have a track already, so just update it
        console.log("UPDATING DB ITEM");
        await db
          .collection("songs")
          .updateOne(
            { id: item.id },
            { $set: { trackPrice: item.trackPrice } }
          );
      } else {
        //Otherwise, insert it
        await db.collection("songs").insertOne(item);

        console.log("DOCUMENT INSERTED");
      }
    } else {
      console.log("SONG NOT FOUND, SETTING PRICE TO 0");
      item.trackPrice = trackPrice;

      if (currentTrack) {
        //We have a track already, so just update it
        console.log("UPDATING DB ITEM - NOT FOUND");
        await db
          .collection("songs")
          .updateOne(
            { id: item.id },
            { $set: { trackPrice: item.trackPrice } }
          );
      } else {
        //Otherwise, insert it
        await db.collection("songs").insertOne(item);

        console.log("DOCUMENT INSERTED - NOT FOUND");
      }
    }
    counter++;
    console.log("CURRENT TOTAL PRICE", total);
  }

  if (counter === 15) {
    console.log("COUNTER LIMIT HIT");
    console.log(`SNOOZING FOR 1 MINUTE - COUNTER AT: ${counter}`);
    await snooze(80000);

    counter = 0;
  }

  console.log("TOTAL TRACK PRICE", total);
};

const buildITunesSearchEndpointQueryTerms = (terms) =>
  terms.reduce((pre, next) => {
    return pre + `&term=${next}`;
  });

const getITunesSearchEndpointQueryOptions = (termType, values) => {
  //Decide if we want to use song name, artist name, both, include album name ect to help make sure we get a song match
  switch (termType) {
    // SONG ONLY
    case 1:
      return `&term=${buildITunesSearchEndpointQueryTerms([values.songName])}`;
    // SONG AND ARTIST
    case 2:
      return `&term=${buildITunesSearchEndpointQueryTerms([
        values.songName,
        values.artistName,
      ])}`;

    default:
      return null;
  }
};

const calculateTrackPrice = (track) => {
  //Input is an ITUNES TRACK, not SPOTIFY

  if (!track) return 0;

  if (track.trackPrice > 0) return track.trackPrice;

  //Some tracks are negative values, assuming that means you can't buy the single, so get average cost of each track for collection price and number of tracks in album
  if (track.trackPrice < 0) {
    return track.collectionPrice / track.trackCount;
  }

  return 0;
};

const getITunesSearchSong = async (termType, track) => {
  let data = null;

  try {
    const trackData = {
      songName: track.name,
      artistName: track.artists[0].name,
    };

    console.log("TERM TYPE", termType);
    const queryTerms = getITunesSearchEndpointQueryOptions(termType, trackData);

    const queryTermsSanitized = !queryTerms
      ? null
      : queryTerms.replace(/'/gi, "'");

    console.log(
      "QUERY TERMS",
      queryTermsSanitized,
      `https://itunes.apple.com/search?media=music&entity=song${queryTermsSanitized}`
    );

    if (!queryTermsSanitized) return null;

    console.log("GRABBING DATA");

    data = await axios.get(
      `https://itunes.apple.com/search?media=music&entity=song${queryTermsSanitized}`
    );
  } catch (err) {
    console.log("ERROR");

    //If forbidden, we've probably done too many requests, so wait 60 seconds
    if (err.hasOwnProperty("response") && err.response.status == 403) {
      console.log("403 - SNOOZING FOR A MINUTE");
      await snooze(80000);
    }

    return null;
  }

  if (data) {
    console.log("FOUND DATA");
    let song = data.data.results.find(
      (x) =>
        x.trackName.toUpperCase() == track.name.toUpperCase() &&
        x.artistName.toUpperCase() == track.artists[0].name.toUpperCase()
    );

    if (!song) {
      console.log(
        "COULDNT FIND SONG - TRYING PARTIAL MATCH OR ADDING ADDITIONAL TERMS"
      );

      // Can't find song - try a partial match first -- itunes includes spotify
      song = data.data.results.find(
        (x) =>
          x.trackName.toUpperCase().includes(track.name.toUpperCase()) &&
          x.artistName
            .toUpperCase()
            .includes(track.artists[0].name.toUpperCase())
      );

      // Try the reverse?
      song = data.data.results.find(
        (x) =>
          track.name.toUpperCase().includes(x.trackName.toUpperCase()) &&
          track.artists[0].name
            .toUpperCase()
            .includes(x.artistName.toUpperCase())
      );

      // Either return the song if we found a partial name match or increment term search
      let incrementedTermType = termType + 1;
      return !song ? getITunesSearchSong(incrementedTermType, track) : song;
    }

    return song;
  }
};
