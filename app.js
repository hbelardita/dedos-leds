import { FilesetResolver, HandLandmarker } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/vision_bundle.mjs';

// --- Constantes y estado principal ---

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm';
const MODELO_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const PARES_DEDOS = [[8, 6], [12, 10], [16, 14], [20, 18]];
const LEDS_CONFIG = [
  { pin: 2, nombre: 'azul' },
  { pin: 3, nombre: 'amarillo' },
  { pin: 4, nombre: 'rojo' },
  { pin: 5, nombre: 'verde' },
  { pin: 6, nombre: 'verde' },
];
const FRAMES_ESTABLES = 4;

const camara = {
  fase: 'apagada', // 'apagada' | 'permiso' | 'cargando' | 'activa' | 'error'
  stream: null,
  detector: null,
  ultimoTiempoVideo: -1,
  intentoId: 0,
  rafId: null,
};

const estabilizador = {
  candidato: null,
  framesSeguidos: 0,
  estable: null,
  ultimoAnunciado: undefined,
};

const arduino = {
  soportado: 'serial' in navigator,
  puerto: null,
  escritor: null,
  conectando: false,
  listo: false,
  ultimoEnviado: null,
  timerReinicio: null,
  error: null,
};

// Referencias del DOM
const elEscenario = document.getElementById('escenario');
const elVideo = document.getElementById('video');
const elMarcadorCamara = document.getElementById('marcador-camara');
const elInicioTitulo = document.getElementById('inicio-titulo');
const elInicioDescripcion = document.getElementById('inicio-descripcion');
const elCapaCarga = document.getElementById('capa-carga');
const elCargaTexto = document.getElementById('carga-texto');
const elAvisoDeteccion = document.getElementById('aviso-deteccion');
const elEstadoHardware = document.getElementById('estado-hardware');
const elEstadoHardwareTexto = document.getElementById('estado-hardware-texto');
const elConteoInsignia = document.getElementById('conteo-insignia');
const elConteoNumero = document.getElementById('conteo-numero');
const elConteoEtiqueta = document.getElementById('conteo-etiqueta');
const elAnuncioConteo = document.getElementById('anuncio-conteo');
const elUnidadesLed = Array.from(document.querySelectorAll('#fila-leds .led-unidad'));
const btnCamara = document.getElementById('btn-camara');
const btnCamaraTexto = btnCamara.querySelector('.boton-texto');
const btnCamaraEscenario = document.getElementById('btn-camara-escenario');
const btnCamaraEscenarioTexto = btnCamaraEscenario.querySelector('.boton-texto');
const btnCancelarCarga = document.getElementById('btn-cancelar-carga');
const btnArduino = document.getElementById('btn-arduino');
const btnArduinoTexto = btnArduino.querySelector('.boton-texto');
const btnPantalla = document.getElementById('btn-pantalla');

// --- Lógica pura de detección ---

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

function reiniciarEstabilizador() {
  estabilizador.candidato = null;
  estabilizador.framesSeguidos = 0;
  estabilizador.estable = null;
  estabilizador.ultimoAnunciado = undefined;
}

// --- Renderizado de estado (hardware y detección desacoplados) ---

function arduinoIniciando() {
  return Boolean(arduino.puerto && !arduino.listo);
}

function renderizarHardware() {
  let nivel = 'simulado';
  let texto = 'Solo en pantalla';

  if (arduino.error) {
    nivel = 'error';
    texto = arduino.error;
  } else if (arduino.conectando) {
    nivel = 'iniciando';
    texto = 'Conectando Arduino…';
  } else if (arduinoIniciando()) {
    nivel = 'iniciando';
    texto = 'Reiniciando Arduino (2 s)…';
  } else if (arduino.listo) {
    nivel = 'conectado';
    texto = 'Arduino conectado';
  } else if (!arduino.soportado) {
    nivel = 'no-soportado';
    texto = 'Solo en pantalla · USB en Chrome o Edge';
  }

  elEstadoHardware.dataset.nivel = nivel;
  if (elEstadoHardwareTexto.textContent !== texto) {
    elEstadoHardwareTexto.textContent = texto;
  }

  if (!arduino.soportado) {
    btnArduino.disabled = true;
    btnArduino.setAttribute('aria-disabled', 'true');
    btnArduino.title = 'Web Serial solo funciona en Chrome o Edge';
    btnArduinoTexto.textContent = 'Arduino (Chrome/Edge)';
  } else if (arduino.conectando) {
    btnArduino.disabled = true;
    btnArduino.setAttribute('aria-busy', 'true');
    btnArduinoTexto.textContent = 'Conectando…';
  } else if (arduino.puerto) {
    btnArduino.disabled = false;
    btnArduino.removeAttribute('aria-busy');
    btnArduino.title = '';
    btnArduinoTexto.textContent = 'Desconectar Arduino';
  } else {
    btnArduino.disabled = false;
    btnArduino.removeAttribute('aria-busy');
    btnArduino.title = '';
    btnArduinoTexto.textContent = 'Conectar Arduino';
  }

  renderizarAvisoEscenario();
}

function renderizarAvisoEscenario() {
  if (camara.fase !== 'activa') {
    elAvisoDeteccion.hidden = true;
    return;
  }

  if (arduinoIniciando()) {
    elAvisoDeteccion.textContent = 'Sincronizando Arduino (2 s)…';
    elAvisoDeteccion.hidden = false;
    return;
  }

  if (estabilizador.estable === null) {
    elAvisoDeteccion.textContent = 'Mostrá una mano abierta frente a la cámara';
    elAvisoDeteccion.hidden = false;
    return;
  }

  elAvisoDeteccion.hidden = true;
}

function renderizarEscenario(mensajeError = null) {
  elEscenario.dataset.fase = camara.fase;

  const cargando = camara.fase === 'permiso' || camara.fase === 'cargando';
  const activa = camara.fase === 'activa';

  elMarcadorCamara.hidden = activa || cargando;
  elCapaCarga.hidden = !cargando;
  elConteoInsignia.hidden = !activa;

  if (camara.fase === 'permiso') {
    elCargaTexto.textContent = 'Solicitando permiso de cámara…';
  } else if (camara.fase === 'cargando') {
    elCargaTexto.textContent = 'Preparando detector de manos…';
  }

  if (camara.fase === 'apagada') {
    elInicioTitulo.textContent = 'Mostrá tu mano para encender los 5 LEDs';
    elInicioDescripcion.textContent = 'Levantá de 0 a 5 dedos frente a la cámara. Funciona en pantalla o con un Arduino conectado por USB.';
    btnCamaraEscenarioTexto.textContent = 'Iniciar cámara';
  } else if (camara.fase === 'error' && mensajeError) {
    elInicioTitulo.textContent = mensajeError.titulo;
    elInicioDescripcion.textContent = mensajeError.detalle;
    btnCamaraEscenarioTexto.textContent = 'Reintentar';
  }

  btnCamara.disabled = cargando;
  btnCamaraEscenario.disabled = cargando;

  if (cargando) {
    btnCamara.setAttribute('aria-busy', 'true');
    btnCamaraTexto.textContent = 'Preparando…';
  } else if (activa) {
    btnCamara.removeAttribute('aria-busy');
    btnCamaraTexto.textContent = 'Detener cámara';
  } else {
    btnCamara.removeAttribute('aria-busy');
    btnCamaraTexto.textContent = 'Iniciar cámara';
  }

  renderizarAvisoEscenario();
}

function anunciarConteo(estable) {
  if (estabilizador.ultimoAnunciado === estable) return;
  estabilizador.ultimoAnunciado = estable;

  if (estable === null) {
    elAnuncioConteo.textContent = 'Sin mano en pantalla';
  } else if (estable === 0) {
    elAnuncioConteo.textContent = '0 dedos, todos los LEDs apagados';
  } else if (estable === 1) {
    elAnuncioConteo.textContent = '1 dedo, 1 LED encendido';
  } else {
    elAnuncioConteo.textContent = `${estable} dedos, ${estable} LEDs encendidos`;
  }
}

function renderizarConteo(estable) {
  const encendidos = estable ?? 0;

  if (estable === null) {
    elConteoNumero.textContent = '0';
    elConteoEtiqueta.textContent = 'listo';
  } else {
    elConteoNumero.textContent = String(estable);
    elConteoEtiqueta.textContent = estable === 1 ? 'dedo' : 'dedos';
  }

  elUnidadesLed.forEach((unidad, indice) => {
    const activo = indice < encendidos;
    const svg = unidad.querySelector('.led');
    const info = LEDS_CONFIG[indice];
    const estadoTexto = activo ? 'encendido' : 'apagado';
    unidad.dataset.active = String(activo);
    if (svg) {
      svg.dataset.active = String(activo);
      svg.setAttribute('aria-label', `LED ${indice + 1} ${info.nombre} ${estadoTexto}`);
    }
  });

  if (camara.fase === 'activa') {
    anunciarConteo(estable);
  }
  renderizarAvisoEscenario();
}

// --- Arduino por Web Serial ---

async function enviarArduino(cantidad) {
  if (!arduino.escritor || !arduino.listo) return;
  if (cantidad === arduino.ultimoEnviado) return;
  arduino.ultimoEnviado = cantidad;
  try {
    await arduino.escritor.write(new Uint8Array([48 + cantidad]));
  } catch {
    await desconectarArduino('Se perdió la conexión USB con el Arduino.');
  }
}

async function desconectarArduino(mensajeError = null) {
  if (arduino.timerReinicio !== null) {
    clearTimeout(arduino.timerReinicio);
    arduino.timerReinicio = null;
  }

  const { escritor, puerto } = arduino;
  arduino.escritor = null;
  arduino.puerto = null;
  arduino.conectando = false;
  arduino.listo = false;
  arduino.ultimoEnviado = null;
  arduino.error = mensajeError;

  if (puerto) {
    puerto.removeEventListener('disconnect', manejarDesconexionPuerto);
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

  renderizarHardware();
}

function manejarDesconexionPuerto() {
  desconectarArduino('Arduino desconectado. Volvió a solo en pantalla.');
}

async function conectarArduino() {
  if (!arduino.soportado || arduino.conectando) {
    return;
  }
  if (arduino.puerto) {
    await desconectarArduino(null);
    return;
  }

  arduino.error = null;
  arduino.conectando = true;
  renderizarHardware();

  try {
    const puerto = await navigator.serial.requestPort();
    await puerto.open({ baudRate: 9600 });
    const escritor = puerto.writable.getWriter();

    arduino.puerto = puerto;
    arduino.escritor = escritor;
    arduino.conectando = false;
    arduino.listo = false;
    arduino.ultimoEnviado = null;

    puerto.addEventListener('disconnect', manejarDesconexionPuerto);
    renderizarHardware();

    // El Arduino Uno se reinicia al abrir el puerto serial (~2 s).
    arduino.timerReinicio = setTimeout(() => {
      arduino.timerReinicio = null;
      arduino.listo = true;
      renderizarHardware();
      enviarArduino(estabilizador.estable ?? 0);
    }, 2000);
  } catch (err) {
    arduino.conectando = false;
    if (err?.name === 'NotFoundError') {
      renderizarHardware();
      return;
    }
    await desconectarArduino('No se pudo conectar el Arduino. Verificá el cable USB.');
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

function detenerPistasVideo() {
  const stream = camara.stream || elVideo.srcObject;
  if (stream) {
    for (const pista of stream.getTracks()) {
      pista.stop();
    }
  }
  camara.stream = null;
  elVideo.srcObject = null;
}

function detenerCamara({ faseFinal = 'apagada', mensajeError = null } = {}) {
  camara.intentoId += 1;
  if (camara.rafId !== null) {
    cancelAnimationFrame(camara.rafId);
    camara.rafId = null;
  }
  detenerPistasVideo();
  camara.fase = faseFinal;
  camara.ultimoTiempoVideo = -1;
  reiniciarEstabilizador();
  renderizarConteo(null);
  enviarArduino(0);
  renderizarEscenario(mensajeError);
}

async function iniciarCamara() {
  if (camara.fase === 'permiso' || camara.fase === 'cargando' || camara.fase === 'activa') {
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    detenerCamara({
      faseFinal: 'error',
      mensajeError: {
        titulo: 'Cámara no disponible en este navegador',
        detalle: 'Abrí esta página desde un navegador compatible con cámara (como Chrome o Edge) en conexión segura.',
      },
    });
    return;
  }

  const intento = ++camara.intentoId;
  camara.fase = 'permiso';
  renderizarEscenario();

  // Paso 1: solicitar cámara (errores de permiso o hardware)
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch {
    if (intento !== camara.intentoId) return;
    detenerCamara({
      faseFinal: 'error',
      mensajeError: {
        titulo: 'No se pudo acceder a la cámara',
        detalle: 'Revisá los permisos del navegador o verificá que la cámara esté conectada y libre.',
      },
    });
    return;
  }

  if (intento !== camara.intentoId) {
    for (const pista of stream.getTracks()) pista.stop();
    return;
  }

  camara.stream = stream;
  elVideo.srcObject = stream;
  try {
    await elVideo.play();
  } catch {
    if (intento !== camara.intentoId) return;
    detenerCamara({
      faseFinal: 'error',
      mensajeError: {
        titulo: 'No se pudo reproducir el video',
        detalle: 'Intentá iniciar la cámara nuevamente o elegí otra cámara en la configuración del navegador.',
      },
    });
    return;
  }

  // Paso 2: cargar modelo MediaPipe (errores de red/WASM separados de cámara)
  if (!camara.detector) {
    camara.fase = 'cargando';
    renderizarEscenario();
    try {
      const detector = await crearDetector();
      if (intento !== camara.intentoId) return;
      camara.detector = detector;
    } catch {
      if (intento !== camara.intentoId) return;
      detenerCamara({
        faseFinal: 'error',
        mensajeError: {
          titulo: 'No se pudo cargar el detector de manos',
          detalle: 'La cámara funciona, pero falló la descarga del modelo. Verificá la conexión a internet y presioná Reintentar.',
        },
      });
      return;
    }
  }

  if (intento !== camara.intentoId) return;

  camara.fase = 'activa';
  camara.ultimoTiempoVideo = -1;
  reiniciarEstabilizador();
  renderizarEscenario();
  renderizarConteo(null);
  camara.rafId = requestAnimationFrame(buclePrincipal);
}

function hayFrameNuevo() {
  return camara.detector
    && elVideo.readyState >= 2
    && elVideo.currentTime !== camara.ultimoTiempoVideo;
}

function detectarDedos(ahoraMs) {
  const resultado = camara.detector.detectForVideo(elVideo, ahoraMs);
  const landmarks = resultado.landmarks?.[0];
  if (!landmarks) {
    return null;
  }
  const mano = resultado.handedness?.[0]?.[0]?.categoryName || 'Right';
  return contarDedos(landmarks, mano);
}

function procesarFrame(ahoraMs) {
  camara.ultimoTiempoVideo = elVideo.currentTime;
  const conteo = detectarDedos(ahoraMs);
  const estable = estabilizarConteo(conteo);
  renderizarConteo(estable);
  enviarArduino(estable ?? 0);
}

function buclePrincipal(ahoraMs) {
  if (camara.fase !== 'activa') {
    camara.rafId = null;
    return;
  }
  if (hayFrameNuevo()) {
    procesarFrame(ahoraMs);
  }
  camara.rafId = requestAnimationFrame(buclePrincipal);
}

// --- Controles auxiliares (Pantalla completa) ---

function actualizarBotonPantalla() {
  const activo = document.fullscreenElement === elEscenario;
  btnPantalla.setAttribute('aria-label', activo ? 'Salir de pantalla completa' : 'Activar pantalla completa');
  btnPantalla.title = activo ? 'Salir de pantalla completa' : 'Pantalla completa';
}

async function alternarPantallaCompleta() {
  try {
    if (document.fullscreenElement === elEscenario) {
      await document.exitFullscreen();
    } else {
      await elEscenario.requestFullscreen();
    }
  } catch {
    // Pantalla completa rechazada por el navegador
  }
}

// --- Eventos ---

function manejarClickCamara() {
  if (camara.fase === 'activa') {
    detenerCamara();
  } else {
    iniciarCamara();
  }
}

btnCamara.addEventListener('click', manejarClickCamara);
btnCamaraEscenario.addEventListener('click', iniciarCamara);
btnCancelarCarga.addEventListener('click', () => detenerCamara());
btnArduino.addEventListener('click', conectarArduino);

if (document.fullscreenEnabled) {
  btnPantalla.hidden = false;
  btnPantalla.addEventListener('click', alternarPantallaCompleta);
  document.addEventListener('fullscreenchange', actualizarBotonPantalla);
}

// Estado inicial
renderizarHardware();
renderizarEscenario();
renderizarConteo(null);
