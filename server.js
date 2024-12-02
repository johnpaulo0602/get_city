// server.js

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const NodeCache = require('node-cache'); // Biblioteca de cache em memória
const app = express();
app.use(cors());

const port = process.env.PORT || 3000;

// Configuração do cache
const cache = new NodeCache({ stdTTL: 3600 }); // Tempo de vida padrão de 1 hora

function getDistance(lat1, lon1, lat2, lon2) {
    const radiusEarth = 6371; // Raio da Terra em km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(radiusEarth * c * 100) / 100;
}

async function getRoadDistance(lat1, lon1, lat2, lon2, apiKey) {
    const cacheKey = `roadDistance_${lat1}_${lon1}_${lat2}_${lon2}`;
    let roadDistance = cache.get(cacheKey);

    if (roadDistance !== undefined) {
        console.info(`Distância rodoviária obtida do cache para coordenadas (${lat1}, ${lon1}) -> (${lat2}, ${lon2})`);
        return roadDistance;
    }

    try {
        const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${lat1},${lon1}&destination=${lat2},${lon2}&key=${apiKey}`;
        const response = await axios.get(url);
        if (response.data.status === "OK") {
            roadDistance = Math.round(response.data.routes[0].legs[0].distance.value / 1000 * 100) / 100; // em km
            cache.set(cacheKey, roadDistance);
            return roadDistance;
        } else {
            console.error(`Erro da API Directions: ${response.data.error_message}`);
            return null;
        }
    } catch (error) {
        console.error(`Erro ao chamar a API Directions: ${error.message}`);
        return null;
    }
}

function normalizeString(str) {
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

async function getCityCoordinates(cityName, UF, apiKey) {
    const cacheKey = `cityCoordinates_${cityName}_${UF}`;
    let coordinates = cache.get(cacheKey);

    if (coordinates) {
        console.info(`Coordenadas obtidas do cache para a cidade: ${cityName}, ${UF}`);
        return coordinates;
    }

    console.info(`Buscando coordenadas para a cidade: ${cityName}, ${UF}`);
    const formattedAddress = `${cityName}, ${UF}`;
    const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(formattedAddress)}&key=${apiKey}`;
    try {
        const response = await axios.get(geocodeUrl);
        if (response.data.status === "OK") {
            const latitude = response.data.results[0].geometry.location.lat;
            const longitude = response.data.results[0].geometry.location.lng;
            console.info(`Coordenadas encontradas: Latitude ${latitude}, Longitude ${longitude}`);
            coordinates = { latitude, longitude };
            cache.set(cacheKey, coordinates);
            return coordinates;
        } else {
            console.error(`Erro ao buscar coordenadas: ${response.data.status}`);
            return null;
        }
    } catch (error) {
        console.error('Erro ao fazer a requisição para a API de geocodificação:', error);
        return null;
    }
}

async function getNearbyCities(latitude, longitude, radius, maxRows, usernameGeoNames) {
    const cacheKey = `nearbyCities_${latitude}_${longitude}_${radius}`;
    let nearbyCities = cache.get(cacheKey);

    if (nearbyCities) {
        console.info('Cidades próximas obtidas do cache.');
        return nearbyCities;
    }

    console.info('Buscando cidades próximas...');
    const degreeToKm = 111.32;
    const latAdjust = radius / degreeToKm;
    const lngAdjust = radius / (degreeToKm * Math.cos(latitude * Math.PI / 180));

    const north = latitude + latAdjust;
    const south = latitude - latAdjust;
    const east = longitude + lngAdjust;
    const west = longitude - lngAdjust;

    // Usar o endpoint 'searchJSON' com featureClass=P e style=FULL para obter o 'fcode'
    const geoNamesUrl = `http://api.geonames.org/searchJSON?north=${north}&south=${south}&east=${east}&west=${west}&lang=PT&username=${usernameGeoNames}&maxRows=${maxRows}&style=FULL&featureClass=P`;

    try {
        const response = await axios.get(geoNamesUrl);
        if (response.data.geonames) {
            console.info(`Foram encontradas ${response.data.geonames.length} localidades próximas.`);

            // Filtrar e remover entradas com 'fcode' igual a 'PPLL'
            const filteredGeonames = response.data.geonames.filter(city => city.fcode !== 'PPLL');
            console.info(`Após filtrar, ${filteredGeonames.length} cidades restantes.`);
            cache.set(cacheKey, filteredGeonames);
            return filteredGeonames;
        } else {
            console.error('Nenhuma cidade próxima encontrada.');
            return [];
        }
    } catch (error) {
        console.error('Erro ao buscar cidades próximas:', error);
        return [];
    }
}

async function getMunicipalities() {
    console.info('Buscando lista de municípios do IBGE...');
    const cacheKey = 'municipalities';
    let municipalityMap = cache.get(cacheKey);

    if (!municipalityMap) {
        const urlMunicipios = "https://servicodados.ibge.gov.br/api/v1/localidades/municipios?orderBy=nome";
        try {
            const response = await axios.get(urlMunicipios);
            const municipalities = response.data;

            // Indexar os municípios para busca rápida
            municipalityMap = new Map();
            for (const m of municipalities) {
                const normalizedName = normalizeString(m.nome);
                const ufSigla = m.microrregiao.mesorregiao.UF.sigla;
                const key = `${normalizedName}|${ufSigla}`;
                municipalityMap.set(key, m);
            }

            cache.set(cacheKey, municipalityMap);
            console.info('Mapa de municípios criado e armazenado no cache.');
        } catch (error) {
            console.error('Erro ao buscar municípios:', error);
            municipalityMap = new Map();
        }
    } else {
        console.info('Mapa de municípios obtido do cache.');
    }

    return municipalityMap;
}

async function getPopulationData() {
    console.info('Buscando dados de população do IBGE...');
    const cacheKey = 'populationData';
    let populationData = cache.get(cacheKey);

    if (!populationData) {
        const urlPopulacao = "https://servicodados.ibge.gov.br/api/v3/agregados/6579/periodos/2021/variaveis/9324?localidades=N6";
        try {
            const response = await axios.get(urlPopulacao);
            const series = response.data[0].resultados[0].series;
            populationData = {};
            for (const item of series) {
                const municipioId = item.localidade.id;
                const population = item.serie['2021'];
                populationData[municipioId] = parseInt(population, 10);
            }
            cache.set(cacheKey, populationData);
            console.info('Dados de população obtidos com sucesso e armazenados no cache.');
        } catch (error) {
            console.error('Erro ao buscar dados de população:', error);
            populationData = {};
        }
    } else {
        console.info('Dados de população obtidos do cache.');
    }

    return populationData;
}

async function processCities(latitude, longitude, radius, nearbyCities, municipalityMap, populationData, apiKey, minPopulation) {
    console.info('Processando cidades...');
    const citiesList = [];
    const startTime = Date.now(); // Início da medição de tempo

    for (const city of nearbyCities) {
        const cityLat = parseFloat(city.lat);
        const cityLng = parseFloat(city.lng);

        // Calcula a distância rodoviária
        let roadDistance = await getRoadDistance(latitude, longitude, cityLat, cityLng, apiKey);

        // Se não conseguir, utiliza a distância em linha reta
        if (roadDistance === null) {
            roadDistance = getDistance(latitude, longitude, cityLat, cityLng);
        }

        if (roadDistance <= radius) {
            const cityName = city.name;
            const normalizedCityName = normalizeString(cityName);
            const ufSiglaFromGeoNames = city.adminCodes1 && city.adminCodes1.ISO3166_2 ? city.adminCodes1.ISO3166_2.replace('BR.', '') : null;

            let population = "Desconhecida";
            let ufSigla = "Desconhecida";

            // Construir a chave para busca no mapa de municípios
            const key = `${normalizedCityName}|${ufSiglaFromGeoNames}`;
            const municipality = municipalityMap.get(key);

            if (municipality) {
                const municipioCodigo = municipality.id;
                ufSigla = municipality.microrregiao.mesorregiao.UF.sigla;

                // Obtém a população do cache
                if (populationData[municipioCodigo] !== undefined) {
                    population = populationData[municipioCodigo];
                }
            } else {
                console.warn(`Município não encontrado para a cidade ${cityName} (${ufSiglaFromGeoNames})`);
            }

            // Filtrar com base na população, se necessário
            if (minPopulation) {
                if (typeof population === 'number' && population >= minPopulation) {
                    citiesList.push({
                        Name: cityName,
                        Population: population,
                        Distance: `${roadDistance} km`,
                        UF: ufSigla
                    });
                }
            } else {
                // Se não houver filtro de população, adicionar todas as cidades
                citiesList.push({
                    Name: cityName,
                    Population: population,
                    Distance: `${roadDistance} km`,
                    UF: ufSigla
                });
            }
        }
    }

    const endTime = Date.now(); // Fim da medição de tempo
    console.info(`Processamento concluído em ${(endTime - startTime) / 1000} segundos. Total de cidades processadas: ${citiesList.length}`);
    return citiesList.sort((a, b) => a.Name.localeCompare(b.Name));
}

app.get('/getNearbyCities', async (req, res) => {
    console.info('Requisição recebida em /getNearbyCities');
    const startTime = Date.now(); // Início da medição de tempo total
    const cityName = req.query.city;
    const UF = req.query.uf;
    const radius = parseFloat(req.query.radius) || 250;
    const minPopulation = req.query.minPopulation ? parseInt(req.query.minPopulation, 10) : null;
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    const usernameGeoNames = process.env.GEONAMES_USERNAME;
    const maxRows = 500;

    if (!cityName || !UF) {
        console.warn('Parâmetros insuficientes fornecidos.');
        return res.status(400).json({ error: 'Por favor, forneça os parâmetros city e uf' });
    }

    if (radius > 250) {
        console.warn('Raio solicitado é maior que 250 km.');
        return res.status(400).json({ error: 'O raio máximo permitido é de 250 km' });
    }

    const coordinates = await getCityCoordinates(cityName, UF, apiKey);

    if (!coordinates) {
        console.error('Erro ao obter as coordenadas da cidade.');
        return res.status(500).json({ error: 'Erro ao buscar coordenadas da cidade' });
    }

    const [municipalityMap, populationData, nearbyCities] = await Promise.all([
        getMunicipalities(),
        getPopulationData(),
        getNearbyCities(coordinates.latitude, coordinates.longitude, radius, maxRows, usernameGeoNames)
    ]);

    const citiesList = await processCities(coordinates.latitude, coordinates.longitude, radius, nearbyCities, municipalityMap, populationData, apiKey, minPopulation);

    console.info('Enviando resposta para o cliente.');
    const endTime = Date.now(); // Fim da medição de tempo total
    console.info(`Tempo total de processamento: ${(endTime - startTime) / 1000} segundos.`);
    res.json(citiesList);
});

app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});
