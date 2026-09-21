# Der gemeinsame Grundriss: Dateiformat und Verfahren

Diese Datei ist die Naht zwischen zwei Projekten. Auf der einen Seite steht das
FHEM-Modul `74_NeatoLocal`, das die Aufzeichnungen schreibt und – wenn es so
kommt – den Grundriss rechnet. Auf der anderen die FTUI-Komponente
`<ftui-neato-map>`, die ihn anzeigt. Dazwischen liegt eine JSON-Datei, und
solange die stimmt, ist alles andere austauschbar.

Sie richtet sich an eine zweite Implementierung – in Perl im Modul, in Python
neben `track_map.py`, egal wo. Die Referenzimplementierung in JavaScript steht
in [`www/ftui/components/neato/neato-plan.js`](../www/ftui/components/neato/neato-plan.js);
sie ist nicht die Wahrheit, sondern nur die erste, und `tools/check-plan.mjs`
entscheidet, ob eine zweite mit ihr übereinstimmt.

## Warum es diese Datei gibt

Ein einzelner Lauf ist die Karte *dieses Laufs*, nicht der Wohnung: eigener
Nullpunkt, eigene Nordrichtung, und nur die Räume, in die der Roboter an dem
Tag kam. Mehrere übereinandergelegt können zweierlei, was keiner allein kann –
fehlende Wände ergänzen und über jede Zelle abstimmen lassen.

Rechnen kann das die Komponente selbst, und für drei oder vier Läufe tut sie
das auch. Darüber hinaus nicht mehr. Gemessen in Chromium, mit gedrosselter
CPU auf Tablet-Tempo:

| | |
|---|---|
| drei Läufe laden, lesen, aufnehmen, zusammenlegen | 1,2 s – auf Tablet-Tempo **5,2 s** |
| dabei heruntergeladen | 2,0 MB |
| zehn Läufe à 1 Stunde bei `mapInterval 15` | etwa **5,5 MB** |
| derselbe Grundriss als fertige Datei | 33 kB, **7 kB** gzip |

Ein Panel soll die Antwort laden, nicht die Frage.

## Das Format

Eine JSON-Datei neben den Aufzeichnungen, also in `<trackDir>`, üblicherweise
`/opt/fhem/www/neato/`. Der Name ist frei; `plan-<Gerätename>.json` ist die
Konvention. FHEMWEB liefert sie ohne weiteres Zutun aus, genau wie die
`.jsonl`-Dateien.

```json
{
  "cell": 0.1,
  "runs": 3,
  "built": "2026-09-21T18:04:11.000Z",
  "files": ["Staubsauger-2026-09-21_10-00-19.jsonl", "…"],
  "cells": [[-34, 12, 3, 3], [-34, 13, 2, 3], [-33, 13, 1, 1], …]
}
```

| Feld | | |
|---|---|---|
| `cell` | Pflicht | Zellgröße in Metern. 0,1 ist der Normalfall; die Anzeige übernimmt, was hier steht. |
| `runs` | Pflicht | Wie viele Läufe eingegangen sind. Ganzzahl ≥ 1. |
| `cells` | Pflicht | Die Zellen, siehe unten. |
| `built` | optional | Wann gerechnet, ISO 8601. Nur zur Anzeige und Fehlersuche. |
| `files` | optional | Welche Aufzeichnungen eingegangen sind, in der Reihenfolge des Einpassens. Die erste ist der Rahmen. |

Jede Zelle ist ein Array aus vier Ganzzahlen:

```
[ ix, iy, walls, seen ]
```

* `ix`, `iy` – Zellindex, **nicht** Meter. Die Weltkoordinate der Zellmitte ist
  `(ix + 0,5) · cell`. Negative Indizes sind normal.
* `walls` – wie viele Läufe diese Zelle Wand nennen. ≥ 1; eine Zelle, die
  niemand für Wand hält, gehört nicht in die Datei.
* `seen` – wie viele Läufe überhaupt **hingesehen** haben. ≥ `walls`, ≤ `runs`.

`seen` ist der Teil, den man beim ersten Lesen für überflüssig hält, und er ist
der wichtigste. Ohne ihn lässt sich nicht unterscheiden zwischen

* einer Wand, die ein Lauf sah und sonst niemand **hinsah** (`1/1`) – die bleibt
  im Plan, nur blasser gezeichnet, und
* einer Wand, die ein Lauf sah, während zwei andere an dieselbe Stelle sahen
  und Boden fanden (`1/3`) – das war der Wäscheständer.

Ein Lauf, der nie in dem Raum war, darf nicht mitstimmen. Genau das drückt
`seen` aus.

### Wo der Nullpunkt liegt

Nirgends. Ein Grundriss hat keinen absoluten Bezugspunkt – er ist nur relativ
zu sich selbst, weil schon die einzelnen Läufe keinen gemeinsamen haben. Zwei
Implementierungen dürfen also zueinander gedreht und verschoben sein; das ist
kein Fehler, und `tools/check-plan.mjs` sagt es als Hinweis statt als Fehler.

Praktisch entsteht der Bezugsrahmen dadurch, dass ein Lauf – der mit den
meisten Wandzellen – unverändert bleibt und die übrigen auf ihn eingepasst
werden.

## Das Verfahren

Für jede Aufzeichnung:

1. **Lesen.** `parseSession`: Kopfzeile, Posen, Scans, Abschlusszeile. Das
   Format und die Koordinatenkonvention stehen in `docs/ftui3-map.md` des
   Modul-Repos. Die Formel für die Punkte ist **gemessen, nicht hergeleitet** –
   ihre Spiegelung sieht in einer halbwegs symmetrischen Wohnung fast genauso
   ordentlich aus. Zelle für Zelle gegen die Python-Referenz prüfen.
2. **Umdrehungen aufeinanderlegen.** Jede Umdrehung um ein paar Zentimeter
   rücken, bis ihre Punkte auf die Karte der übrigen passen
   (`neato-align.js`). Ohne das ist eine Wand ein Bündel paralleler Striche und
   nichts lässt sich sinnvoll einpassen. An einem Stundenlauf gemessen: die
   Scans stimmen danach 40 % besser überein.
3. **Belegungsgitter.** Jeder Strahl zählt die Zellen auf dem Weg als Durchgang
   und die Endzelle als Treffer; `treffer / (treffer + durchgänge) ≥ 0,25` bei
   mindestens 2 Beobachtungen ist Wand, darunter frei, sonst unbekannt. Hinter
   dem Endpunkt wird nichts behauptet.

Dann über alle Aufzeichnungen:

4. **Rahmen wählen.** Der Lauf mit den meisten Wandzellen bleibt, wie er ist.
5. **Einpassen.** Jeden anderen Lauf drehen und verschieben, bis seine
   Wandzellen möglichst gut auf denen des Rahmens liegen. Bewertet wird gegen
   ein leicht verschmiertes Bild des Rahmens (Gewicht `1/(1+Abstand)` bis zu
   zwei Zellen weit), sonst ist die Bewertung eine Klippe statt eines Hangs und
   die Suche hat nichts, woran sie hochklettern kann.
   Zuerst grob über ein Raster von 0,4 m, dann verfeinern in drei Stufen
   (1,2°/0,15 m, dann 0,3°/0,05 m, dann 0,1°/0,02 m), jeweils ±3 Schritte.
6. **Ablehnen, was nicht passt.** Güte unter 0,45 heißt: gehört nicht dazu.
   Eine andere Etage in denselben Rahmen zu zwingen zieht Wände quer durch
   Räume. Gemessen: echte Läufe derselben Wohnung kommen auf 0,63 bis 1,0, ein
   fremder Korridor bleibt unter 0,3.
7. **Abstimmen.** Für jede Zelle, die irgendein Lauf Wand nennt: `walls` ist die
   Zahl der Läufe mit einer Wandzelle **in einer Zelle Umkreis**, `seen` die
   Zahl derer, die die Zelle als Wand oder als frei kennen.

Die Toleranz von einer Zelle gehört in die Abstimmung, **nicht** in die
Zellmenge. Zählt man die aufgeweiteten Zellen mit, werden aus 1816 gemessenen
Zellen über 5000, und die Wohnung sieht aus, als hätte sie meterdicke Wände.
Das ist ein Fehler, den man leicht macht – er stand in der ersten Fassung hier.

### Die Drehungssuche darf einfacher sein

Die JavaScript-Fassung probiert nur **vier** Drehungen statt aller: jeder Lauf
misst die vorherrschende Wandrichtung seiner Wände, und zwei Läufe derselben
Wohnung können sich nur um deren Differenz plus ein Vielfaches des rechten
Winkels unterscheiden. Das macht die Suche dreißigmal schneller – 0,2 s statt
8 s pro Lauf.

**Für eine Implementierung im Modul lohnt sich das vermutlich nicht.** Der
Grund für die Abkürzung war der Browser; ein Hintergrundprozess auf der
FHEM-Kiste darf acht Sekunden brauchen. Eine stumpfe Suche über alle Drehungen
in 3°-Schritten findet dieselbe Antwort – ein Test hält genau das fest
(`test/plan.test.mjs`, „the dominant direction is an optimisation, not a
crutch"). Damit entfällt die ganze Linien-Pipeline, die die Richtung liefert,
und es bleiben Gitter, Ausrichtung, Einpassen und Abstimmung.

Falls die Abkürzung doch gewünscht ist: die Richtung kommt **nicht** aus den
Gitterzellen. Nachbarschaftsrichtungen auf einem Raster sind vom Raster selbst
dominiert; alle drei geprüften Läufe ergaben so exakt 0,00°. Sie muss aus den
an die Punkte gefitteten Geradenstücken kommen.

## Prüfen

```sh
node tools/check-plan.mjs plan.json                              # nur die Form
node tools/check-plan.mjs plan.json --against test/fixtures/plan/plan.json
node tools/check-plan.mjs plan.json --runs /opt/fhem/www/neato   # neu rechnen und vergleichen
```

Verlangt wird **keine** Gleichheit bis auf die letzte Zelle. Das Einpassen ist
eine Bergsteigerei, und die findet in einer anderen Sprache einen leicht
anderen Gipfel. Geprüft wird:

| | |
|---|---|
| Zellen der Referenz wiedergefunden, ±1 Zelle | ≥ 95 % |
| umgekehrt, keine erfunden | ≥ 95 % |
| gleich eingeordnet (sicher / strittig) | ≥ 95 % |
| Zahl der Zellen | 85 bis 115 % |

Die letzte Zeile sieht überflüssig aus und ist es nicht: mit einer Zelle
Toleranz geht ein Plan, dem ein Drittel der Zellen fehlt, sonst glatt durch –
jede fehlende Zelle hat einen Nachbarn, der noch da ist. Auch das stand in der
ersten Fassung des Prüfers.

### Referenzfall

`test/fixtures/plan/` enthält drei Aufzeichnungen derselben erfundenen Wohnung,
jede in ihrem eigenen Bezugsrahmen, und das Ergebnis dieser Implementierung:

| Datei | |
|---|---|
| `room-a.jsonl` | die Wohnung, ungedreht |
| `room-b.jsonl` | um 90° gedreht, um (3,5 / −2) verschoben |
| `room-c.jsonl` | um 200° gedreht, um (−1,5 / 4,25) verschoben, nur halb abgefahren |
| `moves.json` | die Wandsegmente und die angewandten Drehungen, auf den Zentimeter |
| `plan.json` | was diese Implementierung daraus macht: 726 Zellen aus 3 Läufen |

Die Wohnung ist ein **L**, nicht ein Rechteck mit Mittelwand. Letzteres sieht
auf dem Kopf genauso aus – dann gibt es keine richtige Antwort zu finden, und
ein Test, der aus gutem Grund manchmal fehlschlägt, ist schlechter als keiner.

Aus `moves.json` lässt sich die Lösung von Hand nachrechnen. Wird Rahmen *F*
gewählt, so gehört Lauf *X* dorthin gedreht um `θ_F − θ_X` und verschoben um
`t_F − R(θ_F − θ_X)·t_X`. Beispiel: mit `room-b` als Rahmen landet `room-c` bei
250° und (−1,01 / −1,96); diese Implementierung findet 249,6° und
(−0,97 / −1,87) – die Abweichung ist kleiner als eine Zelle und genau die
Genauigkeit, die bei 10-cm-Zellen zu erwarten ist.

Erzeugt werden die Dateien mit `node tools/make-plan-fixture.mjs`.

## Was die Anzeigeseite tut, damit es niemand doppelt baut

`<ftui-neato-map view="plan" plan-file="plan-Staubsauger.json">` lädt die Datei
und zeichnet sie. Drei Arten Zelle, nach `walls` und `seen`:

* `walls / seen ≥ plan-agree` (Standard 0,5) und `seen > 1` → volle Farbe
* dasselbe, aber `seen = 1` → blass: niemand widerspricht, niemand bestätigt
* `walls / seen < plan-agree` → eigene Farbe, strittig

Ohne `plan-file` rechnet die Komponente den Plan selbst aus den neuesten
`plan-runs` Aufzeichnungen. Beides muss dasselbe Bild ergeben; ein Browser-Test
hält die zwei Wege gegeneinander.

## Wenn die Datei woanders liegen soll

Heute wird der Dateiname als Attribut gesetzt. Soll das Modul ihn bekanntgeben
– etwa als Reading `planFile`, so wie es `trackFile` schon tut –, dann sagt
bitte Bescheid, unter welchem Namen: die Komponente kann ihn dann binden, und
niemand muss ihn mehr in die Seite schreiben. Das ist ein kleiner Zusatz und
wartet bewusst darauf, dass die Modulseite entschieden hat.

## Was ausdrücklich nicht behauptet wird

* **Dass die Läufe einen gemeinsamen Nullpunkt haben.** In den geprüften
  Aufzeichnungen haben sie einen – die Basis steht am selben Fleck, gemessener
  Versatz unter 15 cm –, aber die Suche verlässt sich nicht darauf.
* **Dass mehr Läufe immer besser sind.** Zwei Läufe vom selben Nachmittag sehen
  dieselben Möbel am selben Platz und sind sich aus dem falschen Grund einig.
  Die Abstimmung ist nur so unabhängig wie die Läufe.
* **Dass 10 cm die richtige Zellgröße ist.** Sie ist die gemessen brauchbare
  für diese Daten. `cell` steht in der Datei, damit beide Seiten dieselbe
  benutzen – nicht damit sie für alle Zeit 0,1 bleibt.
