const express = require('express')
const app = express()
const path = require('path');
const port = process.env.PORT || 3001
const socketIo = require('socket.io');
const mediasoup = require('mediasoup')

//app.get('/', (req, res) => res.type('html').sendFile(path.join(__dirname, '/client/index.html')));
//app.get('/home', (req, res) => res.type('html').sendFile(path.join(__dirname, '/client/home.html')));
//app.get('/main.js', (req, res) => res.type('application/javascript').sendFile(path.join(__dirname, '/client/main.js')));
//app.get('/styles.css', (req, res) => res.type('text/css').sendFile(path.join(__dirname, '/client/styles.css')));
//app.get('/sala', (req, res) => res.type('html').sendFile(path.join(__dirname, '/client/sala.html')));

app.use(express.static('../cliente/'))
app.use('/sfu',express.static(path.join(__dirname, 'sfu')))

const server = app.listen(port, () => console.log(`Example app listening on port ${port}!`))
const io = socketIo(server);

server.keepAliveTimeout = 120 * 1000
server.headersTimeout = 120 * 1000

let worker
let router
let producerTransport
let consumerTransport
let producer
let consumer

const createWorker = async () => {
  worker = await mediasoup.createWorker({
    rtcMinPort: 2000,
    rtcMaxPort: 2020,
  })
  console.log(`worker pid ${worker.pid}`)

  worker.on('died', error => {
    // This implies something serious happened, so kill the application
    console.error('mediasoup worker has died')
    setTimeout(() => process.exit(1), 2000) // exit in 2 seconds
  })

  return worker
}

worker = createWorker()


const mediaCodecs = [
    {
      kind: 'audio',
      mimeType: 'audio/opus',
      clockRate: 48000,
      channels: 2,
    },
    {
      kind: 'video',
      mimeType: 'video/VP8',
      clockRate: 90000,
      parameters: {
        'x-google-start-bitrate': 1000,
      },
    },
  ]

io.on('connection', async socket => {
    console.log('A client connected');

    socket.on('register', (registerData) => {
        console.log(registerData)
        if (registerData.Max && registerData.To && registerData.From && registerData.CallID && registerData.Expires) {

            socket.emit('redirect', 'sala.html');
        }
    });

    socket.on('disconnect', () => {
        console.log('A client disconnected');
    });


  router = await worker.createRouter({ mediaCodecs, })

  // Client emits a request for RTP Capabilities
  // This event responds to the request
  socket.on('getRtpCapabilities', (callback) => {

    const rtpCapabilities = router.rtpCapabilities

    console.log('rtp Capabilities', rtpCapabilities)

    // call callback from the client and send back the rtpCapabilities
    callback({ rtpCapabilities })
  })
    
  // Client emits a request to create server side Transport
  // We need to differentiate between the producer and consumer transports
  socket.on('createWebRtcTransport', async ({ sender }, callback) => {
    console.log(`Is this a sender request? ${sender}`)
    // The client indicates if it is a producer or a consumer
    // if sender is true, indicates a producer else a consumer
    if (sender)
      producerTransport = await createWebRtcTransport(callback)
    else
      consumerTransport = await createWebRtcTransport(callback)
  })

  // see client's socket.emit('transport-connect', ...)
  socket.on('transport-connect', async ({ dtlsParameters }) => {
    console.log('DTLS PARAMS... ', { dtlsParameters })
    await producerTransport.connect({ dtlsParameters })
  })

  // see client's socket.emit('transport-produce', ...)
  socket.on('transport-produce', async ({ kind, rtpParameters, appData }, callback) => {
    // call produce based on the prameters from the client
    producer = await producerTransport.produce({
      kind,
      rtpParameters,
    })

    console.log('Producer ID: ', producer.id, producer.kind)

    producer.on('transportclose', () => {
      console.log('transport for this producer closed ')
      producer.close()
    })

    // Send back to the client the Producer's id
    callback({
      id: producer.id
    })
  })

  // see client's socket.emit('transport-recv-connect', ...)
  socket.on('transport-recv-connect', async ({ dtlsParameters }) => {
    console.log(`DTLS PARAMS: ${dtlsParameters}`)
    await consumerTransport.connect({ dtlsParameters })
  })

  socket.on('consume', async ({ rtpCapabilities }, callback) => {
    try {
      // check if the router can consume the specified producer
      if (router.canConsume({
        producerId: producer.id,
        rtpCapabilities
      })) {
        // transport can now consume and return a consumer
        consumer = await consumerTransport.consume({
          producerId: producer.id,
          rtpCapabilities,
          paused: true,
        })

        consumer.on('transportclose', () => {
          console.log('transport close from consumer')
        })

        consumer.on('producerclose', () => {
          console.log('producer of consumer closed')
        })

        // from the consumer extract the following params
        // to send back to the Client
        const params = {
          id: consumer.id,
          producerId: producer.id,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        }

        // send the parameters to the client
        callback({ params })
      }
    } catch (error) {
      console.log(error.message)
      callback({
        params: {
          error: error
        }
      })
    }
  })

  socket.on('consumer-resume', async () => {
    console.log('consumer resume')
    await consumer.resume()
  })

});


const createWebRtcTransport = async (callback) => {
    try {
      // https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcTransportOptions
      const webRtcTransport_options = {
        listenIps: [
          {
            ip: '191.36.8.57', // replace with relevant IP address
            announcedIp: '191.36.8.57',
          }
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
      }
  
      // https://mediasoup.org/documentation/v3/mediasoup/api/#router-createWebRtcTransport
      let transport = await router.createWebRtcTransport(webRtcTransport_options)
      console.log(`transport id: ${transport.id}`)
  
      transport.on('dtlsstatechange', dtlsState => {
        if (dtlsState === 'closed') {
          transport.close()
        }
      })
  
      transport.on('close', () => {
        console.log('transport closed')
      })
  
      // send back to the client the following prameters
      callback({
        // https://mediasoup.org/documentation/v3/mediasoup-client/api/#TransportOptions
        params: {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        }
      })
  
      return transport
  
    } catch (error) {
      console.log(error)
      callback({
        params: {
          error: error
        }
      })
    }
  }


