require('dotenv').config();
const express = require('express');
const { Client } = require('@notionhq/client');
const app = express();
const port = process.env.PORT || 3000;

// Inicializar el cliente de Notion
const notion = new Client({ auth: process.env.NOTION_API_KEY });

// Caché para géneros y propiedades de la base de datos
let genresCache = null;
let statusOptionsCache = {
  movie: null,
  tv: null,
};
let viewersOptionsCache = {
  movie: null,
  tv: null,
};

app.use(express.static('public'));
app.use(express.json());

async function loadCache() {
  try {
    // Cargar géneros en la caché
    const genresResponse = await notion.databases.query({
      database_id: process.env.GENRES_DATABASE_ID,
    });
    genresCache = genresResponse.results.map(result => ({
      id: result.id,
      name: result.properties.Name.title[0].text.content,
    }));

    // Cargar opciones de estado en la caché
    const movieDatabaseResponse = await notion.databases.retrieve({
      database_id: process.env.FILM_DATABASE_ID,
    });
    const tvDatabaseResponse = await notion.databases.retrieve({
      database_id: process.env.SERIES_DATABASE_ID,
    });

    const movieStatusProperty = movieDatabaseResponse.properties.Status;
    const tvStatusProperty = tvDatabaseResponse.properties.Status;

    if (movieStatusProperty && movieStatusProperty.status && movieStatusProperty.status.options) {
      statusOptionsCache.movie = movieStatusProperty.status.options.map(option => option.name);
    }

    if (tvStatusProperty && tvStatusProperty.status && tvStatusProperty.status.options) {
      statusOptionsCache.tv = tvStatusProperty.status.options.map(option => option.name);
    }

    // Cargar opciones de viewers en la caché
    const movieViewersProperty = movieDatabaseResponse.properties.Viewers;
    const tvViewersProperty = tvDatabaseResponse.properties.Viewers;

    if (movieViewersProperty && movieViewersProperty.multi_select && movieViewersProperty.multi_select.options) {
      viewersOptionsCache.movie = movieViewersProperty.multi_select.options.map(option => option.name);
    }

    if (tvViewersProperty && tvViewersProperty.multi_select && tvViewersProperty.multi_select.options) {
      viewersOptionsCache.tv = tvViewersProperty.multi_select.options.map(option => option.name);
    }

    console.log('Cache loaded successfully');
  } catch (error) {
    console.error('Error loading cache:', error);
  }
}

app.get('/api/search', async (req, res) => {
  try {
    const query = req.query.q;
    const page = req.query.page || 1;
    const language = 'es-ES'; // Idioma español
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(
      `https://api.themoviedb.org/3/search/multi?api_key=${process.env.TMDB_API_KEY}&query=${encodeURIComponent(query)}&page=${page}&language=${language}`
    );
    const data = await response.json();

    // Obtener proveedores de transmisión para cada película o programa de televisión
    const mediaWithProviders = await Promise.all(data.results.map(async (media) => {
      if (media.media_type === 'movie') {
        const providersResponse = await fetch(
          `https://api.themoviedb.org/3/movie/${media.id}/watch/providers?api_key=${process.env.TMDB_API_KEY}`
        );
        const providersData = await providersResponse.json();
        media.watch_providers = providersData.results;
      } else if (media.media_type === 'tv') {
        const providersResponse = await fetch(
          `https://api.themoviedb.org/3/tv/${media.id}/watch/providers?api_key=${process.env.TMDB_API_KEY}`
        );
        const providersData = await providersResponse.json();
        media.watch_providers = providersData.results;
      }
      return media;
    }));

    res.json({ ...data, results: mediaWithProviders });
  } catch (error) {
    res.status(500).json({ error: 'Error searching media' });
  }
});

app.get('/api/status-options', async (req, res) => {
  try {
    const type = req.query.type;
    if (statusOptionsCache[type]) {
      return res.json(statusOptionsCache[type]);
    }

    const databaseId = type === 'movie' ? process.env.FILM_DATABASE_ID : process.env.SERIES_DATABASE_ID;
    const databaseResponse = await notion.databases.retrieve({
      database_id: databaseId,
    });

    const statusProperty = databaseResponse.properties.Status;
    if (!statusProperty || !statusProperty.status || !statusProperty.status.options) {
      throw new Error('Status property is not defined or does not have select options');
    }

    const statusOptions = statusProperty.status.options.map(option => option.name);
    statusOptionsCache[type] = statusOptions;
    res.json(statusOptions);
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: 'Error fetching status options' });
  }
});

app.get('/api/viewers-options', async (req, res) => {
  try {
    const type = req.query.type;
    if (viewersOptionsCache[type]) {
      return res.json(viewersOptionsCache[type]);
    }

    const databaseId = type === 'movie' ? process.env.FILM_DATABASE_ID : process.env.SERIES_DATABASE_ID;
    const databaseResponse = await notion.databases.retrieve({
      database_id: databaseId,
    });

    const viewersProperty = databaseResponse.properties.Viewers;
    if (!viewersProperty || !viewersProperty.multi_select || !viewersProperty.multi_select.options) {
      throw new Error('Viewers property is not defined or does not have multi-select options');
    }

    const viewersOptions = viewersProperty.multi_select.options.map(option => option.name);
    viewersOptionsCache[type] = viewersOptions;
    console.log(`Viewers options for ${type}:`, viewersOptions); // Agregar registro
    res.json(viewersOptions);
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: 'Error fetching viewers options' });
  }
});

app.post('/api/notion', async (req, res) => {
  try {
    const movie = req.body;
    const databaseId = movie.type === 'Movie' ? process.env.FILM_DATABASE_ID : process.env.SERIES_DATABASE_ID;

    console.log('Adding to Notion to database:', databaseId , movie.type);

    // Usar release_date o first_air_date
    const releaseDate = movie.release_date || movie.first_air_date || 'No release date';

    // Verificar si el ítem ya está en la base de datos
    const existingItemsResponse = await notion.databases.query({
      database_id: databaseId,
      filter: {
        and: [
          {
            property: 'Name',
            title: {
              equals: `${movie.title || movie.name} (${releaseDate})`,
            },
          },
          {
            property: 'Cover Image',
            files: {
              contains: `https://image.tmdb.org/t/p/w500${movie.poster_path}`,
              is_not_empty: true,
            },
          },
        ],
      },
    });

    if (existingItemsResponse.results.length > 0) {
      return res.status(400).json({ message: 'Item already exists in the database' });
    }

    // Obtener la lista de géneros de la base de datos de Notion
    if (!genresCache) {
      const genresResponse = await notion.databases.query({
        database_id: process.env.GENRES_DATABASE_ID,
      });
      genresCache = genresResponse.results.map(result => ({
        id: result.id,
        name: result.properties.Name.title[0].text.content,
      }));
    }

    // Obtener los valores de selección para el campo Status
    if (!statusOptionsCache[movie.type]) {
      const databaseResponse = await notion.databases.retrieve({
        database_id: databaseId,
      });

      const statusProperty = databaseResponse.properties.Status; 
      if (!statusProperty || !statusProperty.status || !statusProperty.status.options) {
        throw new Error('Status property is not defined or does not have select options');
      }

      statusOptionsCache[movie.type] = statusProperty.status.options.map(option => option.name);
    }

    const statusOptions = statusOptionsCache[movie.type];

    // Obtener los valores de selección para el campo Viewers
    if (!viewersOptionsCache[movie.type]) {
      const databaseResponse = await notion.databases.retrieve({
        database_id: databaseId,
      });

      const viewersProperty = databaseResponse.properties.Viewers; 
      if (!viewersProperty || !viewersProperty.multi_select || !viewersProperty.multi_select.options) {
        throw new Error('Viewers property is not defined or does not have multi-select options');
      }

      viewersOptionsCache[movie.type] = viewersProperty.multi_select.options.map(option => option.name);
    }

    const viewersOptions = viewersOptionsCache[movie.type];

    const viewers = movie.viewers || viewersOptions[0];

    // Encontrar el género más cercano
    const closestGenres = movie.genre_ids.map(id => {
      const genreName = getGenreNameById(id); // Función para obtener el nombre del género por ID de TMDB
      const genre = genresCache.find(genre => genre.name.toLowerCase() === genreName.toLowerCase());
      return genre ? { id: genre.id } : null;
    }).filter(genre => genre !== null);

    // Validar el estado
    const status = statusOptions.includes(movie.status) ? movie.status : statusOptions[0];

    // Obtener la plataforma desde los proveedores de transmisión
    const watchProviders = movie.watch_providers && movie.watch_providers.ES ? movie.watch_providers.ES.flatrate : [];
    const platform = watchProviders.length > 0 ? watchProviders[0].provider_name : null;

    const properties = {
      Name: { title: [{ text: { content: `${movie.title || movie.name} (${releaseDate})` } }] },
      Genre: { relation: closestGenres },
      'Cover Image': { files: [{ name: 'cover.jpg', external: { url: `https://image.tmdb.org/t/p/w500${movie.poster_path}` } }] },
      Status: { status: { name: status } },
      'Release Date': { date: { start: releaseDate } },
      Viewers: { multi_select: viewers.map(viewer => ({ name: viewer })) },
    };

    if (platform) {
      properties.Platform = { select: { name: platform } };
    }

    if (movie.type !== 'Movie') {
      properties['Total Episodes'] = { number: movie.total_episodes || null };
    }

    const response = await notion.pages.create({
      parent: { database_id: databaseId },
      properties: properties,
    });
    
    res.json({ message: 'Movie added successfully' });
  } catch (error) { 
    console.log(error);
    res.status(500).json({ error: 'Error adding to Notion' });
  }
});

app.listen(port, async () => {
  await loadCache();
  console.log(`Server running on port ${port}`);
});

// Función para obtener el nombre del género por ID de TMDB
function getGenreNameById(id) {
  const genres = {
    28: 'Action',
    12: 'Adventure',
    16: 'Animation',
    35: 'Comedy',
    80: 'Crime',
    99: 'Documentary',
    18: 'Drama',
    10751: 'Family',
    14: 'Fantasy',
    36: 'History',
    27: 'Horror',
    10402: 'Music',
    9648: 'Mystery',
    10749: 'Romance',
    878: 'Science Fiction',
    10770: 'TV Movie',
    53: 'Thriller',
    10752: 'War',
    37: 'Western',
  };
  return genres[id] || 'Unknown';
}
