require('dotenv').config(); // Carrega as variáveis de ambiente do arquivo .env
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

const port = process.env.PORT || 3000; // Porta definida no .env ou padrão 3000

function getDistance(lat1, lon1, lat2, lon2) {
    const radiusEarth = 6371;
    const dLat = (Math.PI * (lat2 - lat1)) / 180;
    const dLon = (Math.PI * (lon2 - lon1)) / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(Math.PI * lat1 / 180) * Math.cos(Math.PI * lat2 / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(radiusEarth * c * 100) / 100;
}

function normalizeString(str) {
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

async function getCityCoordinates(cityName, countryCode, apiKey) {
    console.info(`Buscando coordenadas para a cidade: ${cityName}`);
    const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(cityName)},${countryCode}&key=${apiKey}`;
    try {
        const response = await axios.get(geocodeUrl);
        if (response.data.status === "OK") {
            const latitude = response.data.results[0].geometry.location.lat;
            const longitude = response.data.results[0].geometry.location.lng;
            console.info(`Coordenadas encontradas: Latitude ${latitude}, Longitude ${longitude}`);
            return { latitude, longitude };
        } else {
            console.error(`Erro ao buscar coordenadas: ${response.data.status}`);
            return null;
        }
    } catch (error) {
        console.error('Erro ao fazer a requisição para a API de geocodificação:', error);
        return null;
    }
}

async function getNearbyCities(latitude, longitude, radius, maxRows, usernameGeoNames, responseStyle) {
    console.info('Buscando cidades próximas...');
    const latRadians = latitude * Math.PI / 180;
    const deltaLat = radius / 111;
    const deltaLon = radius / (111 * Math.cos(latRadians));

    const north = latitude + deltaLat;
    const south = latitude - deltaLat;
    const east = longitude + deltaLon;
    const west = longitude - deltaLon;

    const geoNamesUrl = `http://api.geonames.org/citiesJSON?north=${north}&south=${south}&east=${east}&west=${west}&lang=en&username=${usernameGeoNames}&maxRows=${maxRows}&style=${responseStyle}`;

    try {
        const response = await axios.get(geoNamesUrl);
        if (response.data.geonames) {
            console.info(`Foram encontradas ${response.data.geonames.length} cidades próximas.`);
            return response.data.geonames;
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
    const urlMunicipios = "https://servicodados.ibge.gov.br/api/v1/localidades/municipios?orderBy=nome";
    try {
        const response = await axios.get(urlMunicipios);
        console.info('Lista de municípios obtida com sucesso.');
        return response.data;
    } catch (error) {
        console.error('Erro ao buscar municípios:', error);
        return [];
    }
}

function createMunicipalityMap(municipalities) {
    const map = new Map();
    for (const m of municipalities) {
        const name = normalizeString(m.nome);
        map.set(name, m);
    }
    return map;
}

async function processCities(latitude, longitude, radius, nearbyCities, municipalities, UF) {
    console.info('Processando cidades...');
    const citiesList = [];
    const municipalityMap = createMunicipalityMap(municipalities);

    for (const city of nearbyCities) {
        const cityLat = parseFloat(city.lat);
        const cityLng = parseFloat(city.lng);

        const distance = getDistance(latitude, longitude, cityLat, cityLng);

        if (distance <= radius) {
            const cityName = city.name;
            const normalizedCityName = normalizeString(cityName);

            const municipality = municipalityMap.get(normalizedCityName);

            let population = "Desconhecida";
            let ufSigla = "Desconhecida";

            if (municipality) {
                const municipioCodigo = municipality.id;

                const urlPopulacao = `https://servicodados.ibge.gov.br/api/v3/agregados/6579/periodos/2021/variaveis/9324?localidades=N6[${municipioCodigo}]`;

                try {
                    const popResponse = await axios.get(urlPopulacao);
                    population = popResponse.data[0].resultados[0].series[0].serie['2021'];
                } catch (error) {
                    console.error(`Erro ao buscar população para a cidade ${cityName}:`, error);
                }

                ufSigla = municipality.microrregiao.mesorregiao.UF.sigla;
            }

            if (ufSigla === "Desconhecida" || !ufSigla) {
                ufSigla = UF;
            }

            citiesList.push({
                Name: cityName,
                Population: population,
                Distance: `${distance} km`,
                UF: ufSigla
            });
        }
    }

    console.info(`Processamento concluído. Total de cidades processadas: ${citiesList.length}`);
    return citiesList.sort((a, b) => a.Name.localeCompare(b.Name));
}

app.get('/getNearbyCities', async (req, res) => {
    console.info('Requisição recebida em /getNearbyCities');
    const cityName = req.query.city;
    const UF = req.query.uf;
    const radius = parseFloat(req.query.radius) || 250;
    const countryCode = "BR";
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    const usernameGeoNames = process.env.GEONAMES_USERNAME;
    const responseStyle = "short";
    const maxRows = 500;

    if (!cityName || !UF) {
        console.warn('Parâmetros insuficientes fornecidos.');
        return res.status(400).json({ error: 'Por favor, forneça os parâmetros city e uf' });
    }

    const coordinates = await getCityCoordinates(cityName, countryCode, apiKey);

    if (!coordinates) {
        console.error('Erro ao obter as coordenadas da cidade.');
        return res.status(500).json({ error: 'Erro ao buscar coordenadas da cidade' });
    }

    const municipalities = await getMunicipalities();

    const nearbyCities = await getNearbyCities(coordinates.latitude, coordinates.longitude, radius, maxRows, usernameGeoNames, responseStyle);

    const citiesList = await processCities(coordinates.latitude, coordinates.longitude, radius, nearbyCities, municipalities, UF);

    console.info('Enviando resposta para o cliente.');
    res.json(citiesList);
});

app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});
