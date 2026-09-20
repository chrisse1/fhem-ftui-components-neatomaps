# ftui-neato-map

Eine FTUI3-Komponente, die die Reinigungskarte eines Neato Botvac anzeigt –
das Belegungsgitter aus den Lidar-Scans, die gefahrene Spur darüber, und die
aufgezeichneten Läufe zum Durchblättern.

![Eine Kachel mit der Karte eines Laufs](docs/screenshot.png)

Die Daten kommen vom FHEM-Modul [`74_NeatoLocal`](https://github.com/chrisse1/neato-FHEM).
Das Modul zeichnet auf und schreibt eine Datei je Lauf; gezeichnet wird hier.
Am Modul ändert diese Komponente nichts.

## Was gebraucht wird

* FTUI3 ([knowthelist/ftui](https://github.com/knowthelist/ftui)), installiert
  in `<fhem>/www/ftui/`
* `74_NeatoLocal` mit eingeschalteter Aufzeichnung:

  ```
  attr <Gerät> trackRuns 1
  attr <Gerät> mapInterval 30      # Lidar-Scans; ohne das nur die Spur
  ```

* Die Sitzungsdateien müssen unter `www/` liegen, sonst gibt FHEMWEB sie nicht
  heraus. Der Standard `trackDir` (`./www/neato`, also `/opt/fhem/www/neato/`)
  passt: FHEMWEB liefert das als `/fhem/neato/<Datei>.jsonl` aus, mit
  `Content-Type: text/jsonl`. Die Komponente bildet diese Adresse selbst aus
  `track-dir` und der FHEMWEB-Adresse, die sie von FTUI erfragt – damit stimmt
  sie auch für eine Seite in einem Unterordner. Liegt `trackDir` woanders unter
  `www/`, reicht `track-dir="./www/<Ordner>"`.

## Installation

Das Verzeichnis `components/neato/` in die FTUI-Installation kopieren:

```sh
git clone https://github.com/chrisse1/fhem-ftui-components-neatomaps
cp -r fhem-ftui-components-neatomaps/www/ftui/components/neato \
      /opt/fhem/www/ftui/components/
```

Mehr ist nicht nötig: FTUI lädt zu `<ftui-neato-map>` von sich aus
`components/neato/neato-map.component.js`. Die Beispielseite
`www/ftui/examples/neato-map.html` kann daneben, sie ist nur zum Anschauen.

## Benutzung

```html
<ftui-grid-tile row="1" col="1" width="6" height="5">
  <ftui-grid-header>Staubsauger</ftui-grid-header>

  <ftui-neato-map device="Staubsauger"
                  [track-file]="Staubsauger:trackFile"
                  [state]="Staubsauger:state"></ftui-neato-map>
</ftui-grid-tile>
```

Die Karte nimmt die Größe der Kachel an – den ganzen Platz unterhalb des
Kachelkopfs – und zeichnet sich bei jeder Größenänderung neu, ohne die Daten
noch einmal zu lesen. Geblättert wird mit den Pfeilen, mit Wischen nach links
und rechts oder mit den Pfeiltasten. Ganz links steht der neueste Lauf.

`[track-file]` und `[state]` sind nicht Pflicht, aber nützlich: das erste meldet
einen neuen Lauf, sobald er beginnt, das zweite schaltet die Live-Ansicht ein.
Solange `state` auf `cleaning` steht, wird die laufende Aufzeichnung alle
`refresh-interval` Sekunden nachgeladen.

## Attribute

| Attribut | Standard | Bedeutung |
|---|---|---|
| `device` | – | Name des NeatoLocal-Geräts. Bestimmt, welche Dateien aufgelistet werden. |
| `dir` | aus `track-dir` | URL-Verzeichnis der Sitzungsdateien. Leer heißt: aus dem letzten Teil von `track-dir` und der FHEMWEB-Adresse bilden, also `/fhem/neato/`. Nur setzen, wenn die Dateien woanders ausgeliefert werden. |
| `track-dir` | `./www/neato` | Dasselbe Verzeichnis, wie FHEM es sieht – nur für die Dateiliste. Entspricht dem Attribut `trackDir` des Geräts. |
| `track-file` | – | Reading `trackFile`, zum Binden. Nennt die laufende bzw. letzte Sitzung. |
| `state` | – | Reading `state`, zum Binden. `cleaning` schaltet die Live-Ansicht ein. |
| `index` | `0` | Welcher Lauf gezeigt wird, 0 ist der neueste. Bindbar in beide Richtungen. |
| `limit` | `20` | Wie viele Läufe durchblätterbar sind. |
| `file` | – | Genau eine Datei zeigen, ohne Liste und ohne Blättern. |
| `files` | – | Feste Liste von Dateinamen, durch Komma getrennt. Dann wird FHEM nicht nach der Liste gefragt. |
| `list-command` | – | Eigenes FHEM-Kommando für die Liste, falls das eingebaute nicht passt. |
| `refresh-interval` | `30` | Sekunden zwischen zwei Leseversuchen während eines Laufs, `0` schaltet das ab. |
| `cell` | `0.05` | Zellgröße des Belegungsgitters in Metern. |
| `threshold` | `0.25` | Ab welchem Anteil Treffer eine Zelle als Wand gilt. |
| `min-seen` | `2` | Wie oft eine Zelle beobachtet sein muss, bevor sie überhaupt zählt. |
| `pad` | `0.4` | Rand um die Karte in Metern. |
| `show-track` | an | Die gefahrene Spur zeichnen. |
| `show-points` | aus | Die rohen Endpunkte statt des Belegungsgitters zeichnen. |
| `show-info` | an | Zeile mit Datum, Strecke, Dauer und Zähler. |
| `show-controls` | an | Die Pfeile zum Blättern. |
| `locale` | Seitensprache | `de` oder `en`, für Datum und die wenigen Texte. |

Farben kommen aus dem FTUI-Thema und lassen sich einzeln setzen:

```html
<ftui-neato-map style="--neato-map-wall-color: #9ec9f0;
                       --neato-map-track-color: #ffb454;
                       --neato-map-free-opacity: 0.22"></ftui-neato-map>
```

Es gibt `--neato-map-wall-color`, `--neato-map-free-color`,
`--neato-map-free-opacity`, `--neato-map-point-color`,
`--neato-map-track-color`, `--neato-map-start-color`, `--neato-map-end-color`,
`--neato-map-background` und `--neato-map-text-color`.

## Wie die Liste der Läufe zustande kommt

FHEMWEB liefert Dateien aus, aber kein Verzeichnis. Die Komponente fragt FHEM
deshalb nach den Namen – ein Perl-Ausdruck, gebaut aus `track-dir` und `device`:

```
{ join("\n", reverse sort map { (split m,/,)[-1] } <./www/neato/Staubsauger-*.jsonl>) }
```

Der Ausdruck enthält bewusst kein Semikolon: FHEM zerlegt eine Kommandozeile an
`;`, bevor es sich die geschweiften Klammern ansieht.

Wenn die Installation keine Perl-Kommandos über FHEMWEB zulässt
(`allowedCommands`), bleibt die Liste leer. Die Komponente zeigt dann den Lauf
aus dem Reading `trackFile` – also den aktuellen – und sonst einen Hinweis.
Zwei Auswege:

* `files="Staubsauger-2026-09-20_11-59-11.jsonl, …"` – feste Liste, kein
  Kommando nötig.
* `list-command="get myList sessions"` – ein eigenes Kommando, dessen Ausgabe
  Dateinamen sind, durch Zeilenumbruch oder Komma getrennt.

## Was die Karte zeigt

Ein Lidar-Strahl, der bei drei Metern endet, hat auch gemessen, dass der Weg
dorthin frei war. Genau das macht aus einer Punktwolke eine Karte: jede Zelle
zwischen Sensor und Endpunkt zählt als Durchgang, die Zelle des Endpunkts als
Treffer, und `treffer / (treffer + durchgänge)` entscheidet. Hinter dem
Endpunkt wird nichts behauptet.

Die Rechnung steht in `neato-track.js` und ist das Gegenstück zu `tools/track_map.py`
im Modul-Repo; das Verfahren und die Koordinatenkonvention sind dort in
[`docs/ftui3-map.md`](https://github.com/chrisse1/neato-FHEM/blob/dev/docs/ftui3-map.md)
beschrieben. Zwei Fallen, die dort stehen und hier in Tests eingemauert sind:

* Die Formel für die Punkte ist **gemessen**, nicht hergeleitet. Ihre
  Spiegelung sieht in einer halbwegs symmetrischen Wohnung fast genauso
  ordentlich aus. `test/session.test.mjs` vergleicht darum Zelle für Zelle mit
  dem Ergebnis der Python-Referenz, nicht nur die Anzahl.
* In SVG wächst `y` nach unten, in den Daten nach oben.

Und was die Karte *nicht* ist: kein Grundriss der Wohnung, sondern des Laufs.
Fehlt ein Raum, war der Roboter nicht drin. Zwei Läufe lassen sich nicht
übereinanderlegen, jeder hat seinen eigenen Nullpunkt.

Gerechnet wird beim Laden, im Haupt-Thread. Ein langer Lauf mit
`mapInterval 5` – 300 Scans, 85 000 Punkte – braucht dafür rund 20 ms; das
Gitter wächst mit der Wohnung, nicht mit der Datenmenge. Ein Worker lohnt
nicht.

## Entwickeln und Prüfen

Die Rechnung lässt sich ohne Roboter, ohne FHEM und ohne Browser prüfen:

```sh
node --test 'test/*.test.mjs'          # nur die Karten-Mathematik
```

`test/fixtures/reference-track-botvac-d6.jsonl` ist die echte, ausgedünnte
Aufzeichnung aus dem Modul-Repo; `test/fixtures/expected-grid.json` enthält das,
was die Python-Referenz daraus macht, und wird mit
`tools/expected_from_python.py <Pfad zum neato-FHEM-Klon>` neu erzeugt.

Für die Prüfung im Browser – Kachelgröße, Blättern, die Liste aus FHEM, die
Live-Ansicht – braucht es FTUI und Playwright:

```sh
test/get-ftui.sh                       # Klon nach ./.ftui
npm install                            # Playwright
npx playwright install chromium
node --test test/browser.test.mjs
```

Der Test startet ein FHEMWEB-Double (`test/harness/fake-fhem.mjs`), legt die
Komponente über den FTUI-Klon und fährt eine echte FTUI-Seite auf. Fehlt FTUI
oder Playwright, überspringt er sich selbst.

`node tools/screenshot.mjs` macht daraus das Bild oben.

## Lizenz

MIT, wie FTUI. Siehe [LICENSE](LICENSE).
