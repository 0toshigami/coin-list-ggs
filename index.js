const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { SMA, EMA, WMA, ATR } = require('technicalindicators');

const app = express();
const PORT = process.env.PORT || 3176;

// VSA
const lengthVolumeMA = 20
const ratioUltraVolume = 2.2
const ratioVeryHighVolume = 1.8
const ratioHighVolume = 1.2

app.use('/robots.txt', express.static(path.join(__dirname, 'robots.txt')));

const limiter = rateLimit({
    windowMs: 10 * 60 * 1000, // 15 minutes
    max: 10, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.'
});

app.use(limiter);

const userAgentFilter = (req, res, next) => {
    const userAgent = req.headers['user-agent'];
    if (/bot|crawl|spider|slurp|curl/i.test(userAgent)) {
        return res.status(403).send('Access forbidden');
    }
    next();
};

app.use(userAgentFilter);

const apiKey = 'N66MHSPCeYFE30iUxl44gDeNMAA7cisEji5VRIqD3gboxoQSihWAhmoi8hT2koH0';
const apiSecret = 'e9tbP53bdVMWbwWi5qL6ANYJde078x2Y4dX0650Yi9sWe0nHkgrmN8fWHieS4gho';
const serverSecretKey = 'v6yytBHwWi9967xha456KKK45276hxzBcMN65QqPhg';

const accountEndpoint = '/api/v3/account';
const pricesEndpoint = '/api/v3/ticker/price';
const getKlineEndpoint = '/api/v3/klines';

const binanceAPI = axios.create({
    baseURL: 'https://api.binance.com',
    headers: { 'X-MBX-APIKEY': apiKey }
});

// Function to get the current timestamp in milliseconds
const getTimestamp = () => new Date().getTime();

// Function to create HMAC SHA256 signature
const createSignature = (queryString, secret) => {
    return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
};

// Function to get account balances
const getAccountBalances = async () => {
    const timestamp = getTimestamp();
    const queryString = `timestamp=${timestamp}`;
    const signature = createSignature(queryString, apiSecret);

    const url = `${accountEndpoint}?${queryString}&signature=${signature}`;
    // const response = await axios.get(url, {
    //     headers: { 'X-MBX-APIKEY': apiKey }
    // });

    const response = await binanceAPI.get(url)

    return response.data.balances;
};

// Function to get current prices
const getPrices = async () => {
    // const response = await axios.get(pricesEndpoint);
    const response = await binanceAPI.get(pricesEndpoint);
    const prices = {};

    response.data.forEach(price => {
        prices[price.symbol] = parseFloat(price.price);
    });

    return prices;
};

// Function to get balance in USDT
const getBalanceInUSDT = async () => {
    const balances = await getAccountBalances();
    const prices = await getPrices();

    let totalUSDT = 0;
    const balanceInUSDT = balances.map(balance => {
        const asset = balance.asset;
        const free = parseFloat(balance.free);
        const locked = parseFloat(balance.locked);
        const total = free + locked;
        const symbol = `${asset}USDT`;

        let valueInUSDT = 0;
        if (asset === 'USDT') {
            valueInUSDT = total; // USDT is already in USDT
        } else if (prices[symbol]) {
            valueInUSDT = total * prices[symbol];
        } else if (prices[`${asset}BTC`] && prices['BTCUSDT']) {
            valueInUSDT = total * prices[`${asset}BTC`] * prices['BTCUSDT']; // Convert via BTC if no direct USDT pair
        }

        totalUSDT += valueInUSDT;

        return {
            asset,
            free,
            locked,
            valueInUSDT
        };
    }).filter(balance => balance.valueInUSDT > 0); // Filter out assets with 0 USDT value

    return { balanceInUSDT, totalUSDT };
};

// Middleware to check for the secret key
const checkSecretKey = (req, res, next) => {
    const secretKey = req.headers['x-secret-key'];
    if (secretKey && secretKey === serverSecretKey) {
        next();
    } else {
        res.status(403).send('Forbidden');
    }
};

// fetch all USDT pairs
const getUSDTTradingPairs = async () => {
    const response = await binanceAPI.get(pricesEndpoint);
    return response.data
        .filter(pair => pair.symbol.endsWith('USDT') && !pair.symbol.endsWith('UPUSDT') && !pair.symbol.endsWith('DOWNUSDT'))
        .map(pair => pair.symbol);
};

// Fetch historical data (OHLCV)
const getHistoricalData = async (symbol, interval, limit = 100) => {
    try {
        const response = await binanceAPI.get(getKlineEndpoint, {
            params: {
                symbol,
                interval,
                limit
            }
        });
        return response.data.map(candle => ({
            open: parseFloat(candle[1]),
            high: parseFloat(candle[2]),
            low: parseFloat(candle[3]),
            close: parseFloat(candle[4]),
            volume: parseFloat(candle[5]),
            closeTime: candle[6]
        }));
    } catch (error) {
        console.error(`Error fetching data for ${symbol}:`, error.message);
        return null;
    }
};

// function calculateVolumeMovingAverage(data, window) {
//     let movingAverages = [];

//     if (data.length < window) {
//         return new Array(data.length).fill(0);
//     }

//     for (let i = 0; i <= data.length - window; i++) {
//         let sum = 0;
//         for (let j = 0; j < window; j++) {
//             sum += data[i + j].volume;
//         }
//         let average = sum / window;
//         movingAverages.push(average);
//     }

//     return movingAverages;
// }

// Calculate SMA for volume
// const calculateVolumeWMA = (data, period) => {
//     // return SMA.calculate({ period, values: data.map(d => d.volume) });
//     return WMA.calculate({ period, values: data.map(d => d.volume) });
// };
// WILDERS MA Calculation Function
const calculateWildersMA = (data, period) => {
    const result = [];
    let wildersMA = data.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
    result.push(wildersMA);

    for (let i = period; i < data.length; i++) {
        wildersMA = ((wildersMA * (period - 1)) + data[i]) / period;
        result.push(wildersMA);
    }

    return result;
};

const calculateWMA = (data, period) => {
    return WMA.calculate({ period, values: data })
}

// Calculate EMA for price
const calculateEMA = (data, period) => {
    return EMA.calculate({ period, values: data.map(d => d.close) });
};

// Check trading pair metrics
const checkMetrics4h = async (symbol) => {
    const fourHourData = await getHistoricalData(symbol, '4h');
    const oneDayData = await getHistoricalData(symbol, '1d');

    if (!fourHourData || !oneDayData || fourHourData.length < lengthVolumeMA || oneDayData.length < 21) {
        return false; // Not enough data to calculate MA20 or EMA20
    }

    // volume condition
    // volHigh: currentVolume >= highVolumeMin and currentVolume < veryHighVolumeMin
    // volVeryHigh: currentVolme >= veryHighVolumeMin and currentVolume < ultraHighVolumeMin
    // volUltraHigh: currentVolume >= ultraHighVolumeMin    
    let volumeData = fourHourData.map(data => data.volume);
    let volumeMA = calculateWildersMA(volumeData, 20); // calculateWMA(volumeData, 20) 

    const validLength = volumeData.length - volumeMA.length;
    volumeData = volumeData.slice(validLength)

    // Calculate thresholds
    const ultraHighVolumeMin = volumeMA.map(v => v * ratioUltraVolume);
    const veryHighVolumeMin = volumeMA.map(v => v * ratioVeryHighVolume);
    const highVolumeMin = volumeMA.map(v => v * ratioHighVolume);

    // console.log("===\n")
    const volumeLevels = volumeData.map((volume, i) => {
        if (i < lengthVolumeMA - 1) return null; // Not enough data for WMA calculation yet

        // console.log(`volume ${i}:`, volume)
        // console.log(`volUltraHigh ${i}:`, ultraHighVolumeMin[i])
        // console.log(`volVeryHigh ${i}:`, veryHighVolumeMin[i])
        // console.log(`volHigh ${i}:`, highVolumeMin[i])
        // console.log("----")

        const volUltraHigh = volume >= ultraHighVolumeMin[i];
        const volVeryHigh = volume >= veryHighVolumeMin[i] && volume < ultraHighVolumeMin[i];
        const volHigh = volume >= highVolumeMin[i] && volume < veryHighVolumeMin[i];
        // const volNormal = volume >= normalVolumeMin[i] && volume < highVolumeMin[i];
        // const volLow = volume >= lowVolumeMin[i] && volume < normalVolumeMin[i];
        // const volVeryLow = volume < lowVolumeMin[i];

        return {
            'volUltraHigh': {
                'condition': volUltraHigh,
                'value': ultraHighVolumeMin[i]
            },
            'volVeryHigh': {
                'condition': volVeryHigh,
                'value': veryHighVolumeMin[i]
            },
            'volHigh': {
                'condition': volHigh,
                'value': highVolumeMin[i]
            }
        };
    });

    // price condition
    // current price above EMA20 of 1D
    const currentPrice = oneDayData[oneDayData.length - 1].close;
    const oneDayEMA20 = calculateEMA(oneDayData, 20);
    const priceCondition = currentPrice > oneDayEMA20[oneDayEMA20.length - 1]

    // volume condition
    const previousVolume = fourHourData[fourHourData.length - 2].volume;
    const previousVolumeLevel = volumeLevels[volumeLevels.length - 2];
    const volumeCondition = previousVolumeLevel && (previousVolumeLevel['volUltraHigh'].condition || previousVolumeLevel['volVeryHigh'].condition || previousVolumeLevel['volHigh'].condition);

    if (volumeCondition && priceCondition) {
        console.log(symbol)
        console.log("previous vol", previousVolume)
        console.log("price", currentPrice)
        console.log("previousVolumeLevel", previousVolumeLevel)
        console.log("1dEMA20", oneDayEMA20[oneDayEMA20.length - 1])
        console.log("------\n")
    }

    return {
        'condition': volumeCondition && priceCondition,
        'values': {
            currentPrice,
            previousVolume,
            'volumeHigh': previousVolumeLevel && previousVolumeLevel['volHigh'].condition,
            'volVeryHigh': previousVolumeLevel && previousVolumeLevel['volVeryHigh'].condition,
            'volUltraHigh': previousVolumeLevel && previousVolumeLevel['volUltraHigh'].condition,
            '1dEMA20': oneDayEMA20[oneDayEMA20.length - 1]
        }
    };
};

const checkMetrics1d = async (symbol) => {
    // const fourHourData = await getHistoricalData(symbol, '4h');
    const oneDayData = await getHistoricalData(symbol, '1d');

    if (!oneDayData || oneDayData.length < lengthVolumeMA) {
        return false; // Not enough data to calculate MA20 or EMA20
    }

    // volume condition
    // volHigh: currentVolume >= highVolumeMin and currentVolume < veryHighVolumeMin
    // volVeryHigh: currentVolme >= veryHighVolumeMin and currentVolume < ultraHighVolumeMin
    // volUltraHigh: currentVolume >= ultraHighVolumeMin    
    let volumeData = oneDayData.map(data => data.volume);
    let volumeMA = calculateWildersMA(volumeData, 20); // calculateWMA(volumeData, 20) 

    const validLength = volumeData.length - volumeMA.length;
    volumeData = volumeData.slice(validLength)

    // Calculate thresholds
    const ultraHighVolumeMin = volumeMA.map(v => v * ratioUltraVolume);
    const veryHighVolumeMin = volumeMA.map(v => v * ratioVeryHighVolume);
    const highVolumeMin = volumeMA.map(v => v * ratioHighVolume);

    // console.log("===\n")
    const volumeLevels = volumeData.map((volume, i) => {
        if (i < lengthVolumeMA - 1) return null; // Not enough data for WMA calculation yet

        // console.log(`volume ${i}:`, volume)
        // console.log(`volUltraHigh ${i}:`, ultraHighVolumeMin[i])
        // console.log(`volVeryHigh ${i}:`, veryHighVolumeMin[i])
        // console.log(`volHigh ${i}:`, highVolumeMin[i])
        // console.log("----")

        const volUltraHigh = volume >= ultraHighVolumeMin[i];
        const volVeryHigh = volume >= veryHighVolumeMin[i] && volume < ultraHighVolumeMin[i];
        const volHigh = volume >= highVolumeMin[i] && volume < veryHighVolumeMin[i];
        // const volNormal = volume >= normalVolumeMin[i] && volume < highVolumeMin[i];
        // const volLow = volume >= lowVolumeMin[i] && volume < normalVolumeMin[i];
        // const volVeryLow = volume < lowVolumeMin[i];

        return {
            'volUltraHigh': {
                'condition': volUltraHigh,
                'value': ultraHighVolumeMin[i]
            },
            'volVeryHigh': {
                'condition': volVeryHigh,
                'value': veryHighVolumeMin[i]
            },
            'volHigh': {
                'condition': volHigh,
                'value': highVolumeMin[i]
            }
        };
    });

    // price condition
    // current price above EMA20 of 1D
    const currentPrice = oneDayData[oneDayData.length - 1].close;
    const oneDayEMA20 = calculateEMA(oneDayData, 20);
    const priceCondition = currentPrice > oneDayEMA20[oneDayEMA20.length - 1]

    // volume condition
    const previousVolume = oneDayData[oneDayData.length - 2].volume;
    const previousVolumeLevel = volumeLevels[volumeLevels.length - 2];
    const volumeCondition = previousVolumeLevel && (previousVolumeLevel['volUltraHigh'].condition || previousVolumeLevel['volVeryHigh'].condition || previousVolumeLevel['volHigh'].condition);

    if (volumeCondition && priceCondition) {
        console.log(symbol)
        console.log("previous vol", previousVolume)
        console.log("price", currentPrice)
        console.log("previousVolumeLevel", previousVolumeLevel)
        console.log("1dEMA20", oneDayEMA20[oneDayEMA20.length - 1])
        console.log("------\n")
    }

    return {
        'condition': volumeCondition && priceCondition,
        'values': {
            currentPrice,
            previousVolume,
            'volumeHigh': previousVolumeLevel && previousVolumeLevel['volHigh'].condition,
            'volVeryHigh': previousVolumeLevel && previousVolumeLevel['volVeryHigh'].condition,
            'volUltraHigh': previousVolumeLevel && previousVolumeLevel['volUltraHigh'].condition,
            '1dEMA20': oneDayEMA20[oneDayEMA20.length - 1]
        }
    };
};

const calculateATR = (data, period) => {
    const trueRanges = data.map((candle, i) => {
      if (i === 0) return candle.high - candle.low; // First TR is high - low
  
      const prevClose = data[i - 1].close;
      const highLow = candle.high - candle.low;
      const highPrevClose = Math.abs(candle.high - prevClose);
      const lowPrevClose = Math.abs(candle.low - prevClose);
  
      return Math.max(highLow, highPrevClose, lowPrevClose);
    });
  
    const atr = [];
    let sumTR = trueRanges.slice(0, period).reduce((acc, val) => acc + val, 0);
  
    atr.push(sumTR / period); // First ATR is simple average of TRs
  
    for (let i = period; i < trueRanges.length; i++) {
      const newATR = (atr[atr.length - 1] * (period - 1) + trueRanges[i]) / period;
      atr.push(newATR);
    }
  
    return atr;
  };

const calculateSupertrend = (data, period = 14, multiplier = 3) => {
    // let highs = lows = closes = []
    // for (let i = 0; i < data.length; i++) {
    //     highs.push(data[i].high)
    //     lows.push(data[i].low)
    //     closes.push(data[i].close)
    // }
    // const atr = ATR.calculate({
    //     high: highs,
    //     low: lows,
    //     close: closes,
    //     period: period
    // })

    const atr = calculateATR(data, period)
    // let zerosArray = new Array(data.length - atr.length).fill(0);
    // Append the second array to the zeros array
    // let c_atr = zerosArray.concat(atr);

    // console.log("====\n")
    // console.log(`atr: ${atr.length} | ${data.length}`)    
    // console.log(atr[atr.length - 1])
    // console.log(atr[atr.length - 2])
    // console.log(atr[atr.length - 3])
    // console.log(atr[atr.length - 4])
    // console.log("====\n")

    const supertrend = [];
    // let finalUpperBand = 0;
    // let finalLowerBand = 0;
    // let supertrendValue = 0;
    // let previousClose = data[0].close;

    // for (let i = 0; i < data.length; i++) {
    //     if (i < period) {
    //         supertrend.push({ supertrend: null, signal: null });
    //         continue;
    //     }

    //     const currentClose = data[i].close;
    //     const basicUpperBand = ((data[i].high + data[i].low) / 2) + (multiplier * c_atr[i - period]);
    //     const basicLowerBand = ((data[i].high + data[i].low) / 2) - (multiplier * c_atr[i - period]);

    //     if (basicUpperBand < finalUpperBand || previousClose > finalUpperBand) {
    //         finalUpperBand = basicUpperBand;
    //     }

    //     if (basicLowerBand > finalLowerBand || previousClose < finalLowerBand) {
    //         finalLowerBand = basicLowerBand;
    //     }

    //     if (supertrendValue === finalUpperBand) {
    //         supertrendValue = currentClose > finalUpperBand ? finalLowerBand : finalUpperBand;
    //     } else if (supertrendValue === finalLowerBand) {
    //         supertrendValue = currentClose < finalLowerBand ? finalUpperBand : finalLowerBand;
    //     } else {
    //         supertrendValue = currentClose > finalUpperBand ? finalLowerBand : finalUpperBand;
    //     }

    //     const signal = currentClose > supertrendValue ? 'BUY' : 'SELL';

    //     supertrend.push({ supertrend: supertrendValue, signal: signal });

    //     previousClose = currentClose;
    // }

    for (let i = 0; i < data.length; i++) {
        const hl2 = (data[i].high + data[i].low) / 2;
        if (i < period) {
            supertrend.push({ date: data[i].date, supertrend: null });
            continue;
        }

        const atrValue = atr[i - period];
        const basicUpperBand = hl2 + multiplier * atrValue;
        const basicLowerBand = hl2 - multiplier * atrValue;

        let finalUpperBand, finalLowerBand;

        if (i === period) {
            finalUpperBand = basicUpperBand;
            finalLowerBand = basicLowerBand;
        } else {
            finalUpperBand = (basicUpperBand < supertrend[i - 1].finalUpperBand || data[i - 1].close > supertrend[i - 1].finalUpperBand) 
                ? basicUpperBand 
                : supertrend[i - 1].finalUpperBand;
            finalLowerBand = (basicLowerBand > supertrend[i - 1].finalLowerBand || data[i - 1].close < supertrend[i - 1].finalLowerBand) 
                ? basicLowerBand 
                : supertrend[i - 1].finalLowerBand;
        }

        const trend = (data[i].close > finalUpperBand) 
            ? 'up' 
            : (data[i].close < finalLowerBand) 
            ? 'down' 
            : supertrend[i - 1]?.trend || 'down';

        const value = trend === 'up' ? finalLowerBand : finalUpperBand;

        supertrend.push({
            date: data[i].date,
            supertrend: value,
            trend,
            finalUpperBand,
            finalLowerBand,
        });
    }
    return supertrend;
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.get('/filtered-pairs-4h', checkSecretKey, async (req, res) => {
    try {
        const tradingPairs = await getUSDTTradingPairs();

        //console.log("tradingPairs", tradingPairs)

        const filteredPairs = [];

        for (const symbol of tradingPairs) {
            // if (symbol !== 'BAKEUSDT') continue;

            const meetsCriteria = await checkMetrics4h(symbol);
            if (meetsCriteria.condition) {
                filteredPairs.push({ symbol, 'values': meetsCriteria.values });
            }
            await delay(100);
        }

        res.json(filteredPairs);
    } catch (error) {
        console.error(error);
        res.status(500).send('Internal Server Error');
    }
});

app.get('/filtered-pairs-1d', checkSecretKey, async (req, res) => {
    try {
        const tradingPairs = await getUSDTTradingPairs();

        //console.log("tradingPairs", tradingPairs)

        const filteredPairs = [];

        for (const symbol of tradingPairs) {
            // if (symbol !== 'BAKEUSDT') continue;

            const meetsCriteria = await checkMetrics1d(symbol);
            if (meetsCriteria.condition) {
                filteredPairs.push({ symbol, 'values': meetsCriteria.values });
            }
            await delay(100);
        }

        res.json(filteredPairs);
    } catch (error) {
        console.error(error);
        res.status(500).send('Internal Server Error');
    }
});

app.get('/candle-over-ema-or-uptrend', checkSecretKey, async (req, res) => {
    try {
        const tradingPairs = await getUSDTTradingPairs();

        const priceOverEMAList = []
        const uptrendList = []

        for (const symbol of tradingPairs) {
            // if (symbol !== 'NOTUSDT') continue;
            const oneDayData = await getHistoricalData(symbol, '1h');
            const oneDayEMA20 = calculateEMA(oneDayData, 20);

            // prev close > prev EMA
            const prevPrice = oneDayData[oneDayData.length - 2].close;
            const prevEma20 = oneDayEMA20[oneDayEMA20.length - 2];
            // console.log("=====\n")
            // console.log({
            //     'symbol': symbol,
            //     'price': prevPrice,
            //     'ema20': prevEma20
            // })
            // console.log("=====\n")
            if (prevPrice > prevEma20) {
                priceOverEMAList.push({
                    'symbol': symbol,
                    'price': prevPrice,
                    'ema20': prevEma20
                })
            }            

            // prev close > up supertrend
            const supertrend = calculateSupertrend(oneDayData)
            const { supertrend: prevSupertrend, trend: prevSignal } = supertrend[supertrend.length - 2]
            
            console.log("=====\n")
            console.log(`${supertrend.length}:`, supertrend)

            console.log("=====\n")
            console.log({
                'symbol': symbol,
                'supertrend': prevSupertrend
            })
            console.log("=====\n")
            if (prevSignal === 'up' && prevPrice > prevSupertrend) {
                uptrendList.push({
                    'symbol': symbol,
                    'price': prevPrice,
                    'supertrend': prevSupertrend
                }) 
            }

            // if (symbol === 'NOTUSDT') break; 
        }

        res.json({
            priceOverEMAList,
            uptrendList
        }); 

    } catch (error) {
        console.error(error)
        res.status(500).send('Internal Server Error');
    }
})



app.get('/spot-balance-usdt', checkSecretKey, async (req, res) => {
    try {
        const result = await getBalanceInUSDT();
        res.json(result);
    } catch (error) {
        console.error(error);
        res.status(500).send('Internal Server Error');
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});