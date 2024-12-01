require('dotenv').config(); // Carrega as variáveis de ambiente do arquivo .env
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

const port = process.env.PORT || 3000; // Porta definida no .env ou padrão 3000

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
    try {
        const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${lat1},${lon1}&destination=${lat2},${lon2}&key=${apiKey}`;
        const response = await axios.get(url);
        if (response.data.status === "OK") {
            return Math.round(response.data.routes[0].legs[0].distance.value / 1000 * 100) / 100; // em km
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
    console.info(`Buscando coordenadas para a cidade: ${cityName}, ${UF}`);
    const formattedAddress = `${cityName}, ${UF}`;
    const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(formattedAddress)}&key=${apiKey}`;
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
    const degreeToKm = 111.32;
    const latAdjust = radius / degreeToKm;
    const lngAdjust = radius / (degreeToKm * Math.cos(latitude * Math.PI / 180));

    const north = latitude + latAdjust;
    const south = latitude - latAdjust;
    const east = longitude + lngAdjust;
    const west = longitude - lngAdjust;

    const geoNamesUrl = `http://api.geonames.org/citiesJSON?north=${north}&south=${south}&east=${east}&west=${west}&lang=PT&username=${usernameGeoNames}&maxRows=${maxRows}&style=${responseStyle}`;

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

async function processCities(latitude, longitude, radius, nearbyCities, municipalities, apiKey) {
    console.info('Processando cidades...');
    const citiesList = [];

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

            // Busca o município correspondente pelo nome
            const municipality = municipalities.find(m => normalizeString(m.nome) === normalizedCityName);

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

            citiesList.push({
                Name: cityName,
                Population: population,
                Distance: `${roadDistance} km`,
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
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    const usernameGeoNames = process.env.GEONAMES_USERNAME;
    const responseStyle = "short";
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

    const municipalities = await getMunicipalities();

    const nearbyCities = await getNearbyCities(coordinates.latitude, coordinates.longitude, radius, maxRows, usernameGeoNames, responseStyle);

    const citiesList = await processCities(coordinates.latitude, coordinates.longitude, radius, nearbyCities, municipalities, apiKey);

    console.info('Enviando resposta para o cliente.');
    res.json(citiesList);
});

app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});
