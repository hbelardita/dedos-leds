
    import { FilesetResolver, HandLandmarker } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/vision_bundle.mjs';

    // --- Constantes y estado principal ---

    const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm';
    const MODELO_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
    const PARES_DEDOS = [[8, 6], [12, 10], [16, 14], [20, 18]];
    const NOMBRES_LEDS = ['azul', 'blanco', 'rojo', 'blanco', 'azul'];
    const FRAMES_ESTABLES = 4;

    const camara = { activa: false, detector: null, ultimoTiempoVideo: -1 };
    const estabilizador = { candidato: null, framesSeguidos: 0, estable: null };
    const arduino = { puerto: null, escritor: null, listo: false, ultimoEnviado: null, timerReinicio: null };

    // Referencias del DOM
    const elVideo = document.getElementById('video');
    const elMarcadorCamara = document.getElementById('marcador-camara');
    const elEstado = document.getElementById('estado');
    const elConteoNumero = document.getElementById('conteo-numero');
    const elLeds = Array.from(document.querySelectorAll('#fila-leds .led'));
    const btnCamara = document.getElementById('btn-camara');
    const btnArduino = document.getElementById('btn-arduino');

    // --- Lógica pura ---

    // Cuenta dedos levantados (0..5) según los 21 puntos de la mano y lateralidad.
    function contarDedos(landmarks, mano) {
      let total = 0;
      for (const [punta, media] of PARES_DEDOS) {
        if (landmarks[punta].y < landmarks[media].y) {
          total += 1;
        }
      }
      const pulgarArriba = mano === 'Right'
        ? landmarks[4].x > landmarks[3].x
        : landmarks[4].x < landmarks[3].x;
      if (pulgarArriba) {
        total += 1;
      }
      return total;
    }

    // Filtra parpadeos exigiendo FRAMES_ESTABLES frames iguales seguidos.
    function estabilizarConteo(valorCrudo) {
      if (valorCrudo === estabilizador.candidato) {
        estabilizador.framesSeguidos += 1;
      } else {
        estabilizador.candidato = valorCrudo;
        estabilizador.framesSeguidos = 1;
      }
      if (estabilizador.framesSeguidos >= FRAMES_ESTABLES) {
        estabilizador.estable = estabilizador.candidato;
      }
      return estabilizador.estable;
    }

    // --- Renderizado de interfaz ---

    // Actualiza la barra de estado solo cuando el texto cambia.
    function actualizarEstado(texto) {
      if (elEstado.textContent !== texto) {
        elEstado.textContent = texto;
      }
    }

    function renderizarConteo(estable) {
      elConteoNumero.textContent = estable === null ? '—' : String(estable);
      const encendidos = estable ?? 0;
      elLeds.forEach((led, indice) => {
        const activo = indice < encendidos;
        const estadoTexto = activo ? 'encendido' : 'apagado';
        led.dataset.active = String(activo);
        led.setAttribute('aria-label', `LED ${indice + 1} ${NOMBRES_LEDS[indice]} ${estadoTexto}`);
      });
    }

    // --- Arduino por Web Serial ---

    function estadoSimulado() {
      return 'serial' in navigator
        ? 'Modo simulado (sin Arduino conectado)'
        : 'Web Serial solo funciona en Chrome o Edge (modo simulado)';
    }

    function estadoConexion() {
      if (arduino.puerto && !arduino.listo) {
        return 'Arduino conectado (iniciando...)';
      }
      if (arduino.listo) {
        return 'Arduino conectado';
      }
      return estadoSimulado();
    }

    async function enviarArduino(cantidad) {
      if (!arduino.escritor || !arduino.listo) return;
      if (cantidad === arduino.ultimoEnviado) return;
      arduino.ultimoEnviado = cantidad;
      try {
        await arduino.escritor.write(new Uint8Array([48 + cantidad]));
      } catch {
        await desconectarArduino();
      }
    }

    async function desconectarArduino() {
      if (arduino.timerReinicio !== null) {
        clearTimeout(arduino.timerReinicio);
        arduino.timerReinicio = null;
      }

      const escritor = arduino.escritor;
      const puerto = arduino.puerto;
      arduino.escritor = null;
      arduino.puerto = null;
      arduino.listo = false;
      arduino.ultimoEnviado = null;

      if (puerto) {
        puerto.removeEventListener('disconnect', desconectarArduino);
      }
      if (escritor) {
        try {
          escritor.releaseLock();
        } catch {
          // El lock pudo haberse liberado al desconectar
        }
      }
      if (puerto) {
        try {
          await puerto.close();
        } catch {
          // El puerto ya pudo haberse cerrado
        }
      }

      btnArduino.textContent = 'Conectar Arduino';
      actualizarEstado(estadoSimulado());
    }

    async function conectarArduino() {
      if (!('serial' in navigator)) {
        actualizarEstado('Web Serial solo funciona en Chrome o Edge (modo simulado)');
        return;
      }
      if (arduino.puerto) {
        await desconectarArduino();
        return;
      }

      try {
        const puerto = await navigator.serial.requestPort();
        await puerto.open({ baudRate: 9600 });
        const escritor = puerto.writable.getWriter();

        arduino.puerto = puerto;
        arduino.escritor = escritor;
        arduino.listo = false;
        arduino.ultimoEnviado = null;

        puerto.addEventListener('disconnect', desconectarArduino);
        btnArduino.textContent = 'Desconectar Arduino';
        actualizarEstado('Arduino conectado (iniciando...)');

        // El Arduino Uno se reinicia al abrir el puerto serial (~2 s).
        arduino.timerReinicio = setTimeout(() => {
          arduino.timerReinicio = null;
          arduino.listo = true;
          actualizarEstado('Arduino conectado');
          enviarArduino(estabilizador.estable ?? 0);
        }, 2000);
      } catch (err) {
        if (err && err.name === 'NotFoundError') {
          return;
        }
        await desconectarArduino();
        actualizarEstado('No se pudo conectar con el Arduino. Verificá el cable USB.');
      }
    }

    // --- Cámara, MediaPipe y bucle principal ---

    async function crearDetector() {
      const vision = await FilesetResolver.forVisionTasks(WASM_URL);
      const opciones = {
        baseOptions: { modelAssetPath: MODELO_URL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 1,
      };
      try {
        return await HandLandmarker.createFromOptions(vision, opciones);
      } catch {
        return HandLandmarker.createFromOptions(vision, {
          ...opciones,
          baseOptions: { ...opciones.baseOptions, delegate: 'CPU' },
        });
      }
    }

    async function iniciarCamara() {
      if (camara.activa) return true;

      if (!navigator.mediaDevices?.getUserMedia) {
        actualizarEstado('Tu navegador no permite acceder a la cámara.');
        return false;
      }

      try {
        actualizarEstado('Solicitando acceso a la cámara...');
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        });
        elVideo.srcObject = stream;
        await elVideo.play();
        elMarcadorCamara.hidden = true;

        if (!camara.detector) {
          actualizarEstado('Cargando detector de manos...');
          camara.detector = await crearDetector();
        }

        camara.activa = true;
        camara.ultimoTiempoVideo = -1;
        btnCamara.textContent = 'Detener cámara';
        actualizarEstado(
          estabilizador.estable === null && !(arduino.puerto && !arduino.listo)
            ? 'Sin mano detectada'
            : estadoConexion()
        );
        requestAnimationFrame(buclePrincipal);
        return true;
      } catch {
        detenerCamara();
        actualizarEstado('No se pudo iniciar la cámara. Revisá los permisos o conectá una cámara.');
        return false;
      }
    }

    function detenerCamara() {
      const stream = elVideo.srcObject;
      if (stream) {
        for (const pista of stream.getTracks()) {
          pista.stop();
        }
        elVideo.srcObject = null;
      }
      camara.activa = false;
      camara.ultimoTiempoVideo = -1;
      estabilizador.candidato = null;
      estabilizador.framesSeguidos = 0;
      estabilizador.estable = null;
      elMarcadorCamara.hidden = false;
      btnCamara.textContent = 'Iniciar cámara';
      renderizarConteo(null);
      enviarArduino(0);
      actualizarEstado(estadoConexion());
    }

    function buclePrincipal(ahoraMs) {
      if (!camara.activa) return;

      if (camara.detector && elVideo.readyState >= 2 && elVideo.currentTime !== camara.ultimoTiempoVideo) {
        camara.ultimoTiempoVideo = elVideo.currentTime;
        const resultado = camara.detector.detectForVideo(elVideo, ahoraMs);
        const landmarks = resultado.landmarks?.[0];
        let valorCrudo = null;

        if (landmarks) {
          const mano = resultado.handedness?.[0]?.[0]?.categoryName || 'Right';
          valorCrudo = contarDedos(landmarks, mano);
        }

        const estable = estabilizarConteo(valorCrudo);
        if (estable === null && !(arduino.puerto && !arduino.listo)) {
          actualizarEstado('Sin mano detectada');
        } else {
          actualizarEstado(estadoConexion());
        }
        renderizarConteo(estable);
        enviarArduino(estable ?? 0);
      }

      requestAnimationFrame(buclePrincipal);
    }

    // --- Eventos ---

    btnCamara.addEventListener('click', () => {
      if (camara.activa) {
        detenerCamara();
      } else {
        iniciarCamara();
      }
    });

    btnArduino.addEventListener('click', conectarArduino);

    // Estado inicial de Web Serial al cargar la página
    actualizarEstado(estadoSimulado());
