// Conexiones Arduino Uno (5 LEDs en pines 2, 3, 4, 5, 6):
// Pin 2: azul | Pin 3: amarillo | Pin 4: rojo | Pin 5: verde | Pin 6: verde
// Cada LED: pata larga (+) al pin, pata corta (-) a resistencia de 220 Ω y de ahí a GND.

const int PINES[5] = {2, 3, 4, 5, 6};

void setup() {
  Serial.begin(9600);
  for (int i = 0; i < 5; i++) {
    pinMode(PINES[i], OUTPUT);
    digitalWrite(PINES[i], LOW);
  }
}

void loop() {
  
  if (Serial.available() > 0) {
    int n = Serial.read() - '0';
    if (n >= 0 && n <= 5) {
      for (int i = 0; i < 5; i++) {
        digitalWrite(PINES[i], i < n ? HIGH : LOW);
      }
    }
  }
}
