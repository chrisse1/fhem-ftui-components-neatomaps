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

Über FHEMs eigenen Update-Mechanismus, in der FHEM-Kommandozeile:

```
update add https://raw.githubusercontent.com/chrisse1/fhem-ftui-components-neatomaps/HEAD/controls_neatomaps.txt
update all https://raw.githubusercontent.com/chrisse1/fhem-ftui-components-neatomaps/HEAD/controls_neatomaps.txt
```

Das erste Kommando merkt sich die Quelle (in `FHEM/controls.txt`), das zweite
holt die Dateien. Ab da genügt ein `update`, das dann alle eingetragenen
Quellen durchgeht. Ein `shutdown restart` ist nicht nötig – es sind nur
Dateien unter `www/`; im Browser kann aber ein beherzter Reload nötig sein,
damit die alte Fassung nicht aus dem Cache kommt.

Was dabei wohin geht:

| Datei | |
|---|---|
| `www/ftui/components/neato/` | die Komponente, drei Dateien |
| `www/ftui/examples/neato-map.html` | Beispielseite, **nur angelegt** (`CRE`), nie überschrieben – sie enthält einen Gerätenamen, den man anpasst |

Wer lieber von Hand arbeitet, kopiert dasselbe Verzeichnis selbst:

```sh
git clone https://github.com/chrisse1/fhem-ftui-components-neatomaps
cp -r fhem-ftui-components-neatomaps/www/ftui/components/neato \
      /opt/fhem/www/ftui/components/
```

So oder so ist mehr nicht nötig: FTUI lädt zu `<ftui-neato-map>` von sich aus
`components/neato/neato-map.component.js`.

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
noch einmal zu lesen.

Geblättert wird mit den Pfeilen, mit Wischen oder mit den Pfeiltasten, und
zwar entlang der Zeit: **rechts geht Richtung Gegenwart, links in die
Vergangenheit.** Beim Öffnen steht der neueste Lauf da, der rechte Pfeil ist
also grau, bis man einmal nach links geblättert hat.

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
| `walls` | `lines` | Wie die Wände gezeichnet werden: `lines` zieht gerade Linien daraus, `cells` zeigt die Gitterzellen der rohen Evidenz. |
| `line-tolerance` | `0.04` | Wie weit ein Messpunkt von seiner Linie abweichen darf, in Metern. Größer heißt glatter und ungenauer. |
| `join-gap` | `0.8` | Bis zu welcher Lücke zwei Stücke derselben Flucht zu einer Wand verbunden werden. `0` verbindet nichts. |
| `min-wall` | `0.4` | Kürzere Stücke werden weggelassen – Stuhlbeine, Kabel, Kistenecken. |
| `snap-angle` | `8` | Wie weit ein Stück von der vorherrschenden Richtung abweichen darf, um darauf eingerastet zu werden, in Grad. `0` rastet nichts ein. |
| `cell` | `0.10` | Zellgröße des Belegungsgitters in Metern. |
| `threshold` | `0.25` | Ab welchem Anteil Treffer eine Zelle als Wand gilt. |
| `min-seen` | `2` | Wie oft eine Zelle beobachtet sein muss, bevor sie überhaupt zählt. |
| `pad` | `0.4` | Rand um die Karte in Metern. |
| `show-track` | an | Die gefahrene Spur zeichnen. |
| `show-points` | aus | Die rohen Endpunkte statt des Belegungsgitters zeichnen. |
| `show-info` | an | Zeile mit Datum, Strecke, Dauer und Zähler. |
| `show-controls` | an | Die Pfeile zum Blättern. |
| `text-size` | `0.8` | Schriftgröße der Zeile unter der Karte. Eine bloße Zahl ist em (wie bei `margin` in FTUI), sonst gilt jede CSS-Länge: `text-size="1.4"`, `text-size="16px"`. |
| `arrow-size` | `1.9` | Kantenlänge der Blätterpfeile, in denselben Einheiten. Ohne Angabe wachsen sie mit `text-size` mit. |
| `min-height` | `4` | Wie flach die Kartenfläche schrumpfen darf, wenn der Platz knapp wird. |
| `wall-color` | `primary` | Farbe der Wände. |
| `free-color` | Textfarbe | Farbe der befahrenen Fläche. |
| `free-opacity` | `0.16` | Wie deutlich die Fläche gegen den Untergrund steht. |
| `track-color` | `warning` | Farbe der gefahrenen Spur. |
| `point-color` | `info` | Farbe der Endpunkte bei `show-points`. |
| `start-color` | `success` | Punkt am Anfang des Laufs. |
| `end-color` | `danger` | Punkt am Ende – und der Punkt für den Roboter, solange er fährt. |
| `text-color` | `light` | Farbe der Zeile und der Pfeile. |
| `background-color` | durchsichtig | Untergrund der Kartenfläche; ohne Angabe scheint die Kachel durch. |
| `locale` | Seitensprache | `de` oder `en`, für Datum und die wenigen Texte. |

In einem Popup ist die Kachelschrift oft zu klein; dort lohnen beide:

```html
<ftui-popup width="50%" height="60%" timeout="0" shape="round">
  <ftui-popup-header>Staubsauger</ftui-popup-header>
  <ftui-neato-map device="Staubsauger"
                  [track-file]="Staubsauger:trackFile"
                  [state]="Staubsauger:state"
                  text-size="1.4" arrow-size="3"></ftui-neato-map>
</ftui-popup>
```

Die Karte füllt das Popup-Fenster genauso wie eine Kachel.

### Farben

Die Farbattribute nehmen, was CSS nimmt – und zusätzlich die Farbnamen, die
FTUI überall sonst verwendet (`primary`, `warning`, `danger`, `red`, …). Die
kommen aus dem Thema, passen sich also mit ihm an:

```html
<ftui-neato-map device="Staubsauger"
                wall-color="info"
                track-color="#ffb454"
                free-color="rgb(120, 130, 140)"
                free-opacity="0.22"
                end-color="danger"></ftui-neato-map>
```

Ohne Angabe bleibt es beim Thema: Wände in `primary`, Spur in `warning`,
Anfang in `success`, Ende in `danger`. Ein Attribut wieder auf `""` zu setzen
stellt den Standard zurück.

Jedes dieser Attribute setzt nichts weiter als eine CSS-Variable, die sich auch
direkt setzen lässt – etwa für alle Karten einer Seite auf einmal:
`--neato-map-wall-color`, `--neato-map-free-color`,
`--neato-map-free-opacity`, `--neato-map-point-color`,
`--neato-map-track-color`, `--neato-map-start-color`, `--neato-map-end-color`,
`--neato-map-background`, `--neato-map-text-color`, `--neato-map-font-size`,
`--neato-map-arrow-size`, `--neato-map-min-height`,
`--neato-map-wall-width` (Strichstärke der Wandlinien in Pixeln) und
`--neato-map-button-background`.

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

## Warum die Karte ruhiger ist als die Messung

Eine Wohnung besteht aus geraden Wänden, meist rechtwinklig zueinander. Ein
Lidar, der dieselbe Wand aus vier Positionen sieht, legt vier leicht
verschiedene Punktreihen darauf – als Zellen gezeichnet ein unscharfes Band,
als Linie gezeichnet eine Wand. Die Komponente zieht deshalb Linien, in vier
Schritten:

1. Eine Umdrehung wird an den Sprüngen zerlegt: Wo die Entfernung springt,
   ist der Strahl an einer Kante vorbei auf etwas anderes getroffen.
2. Jedes Stück wird dort geteilt, wo es knickt – am Punkt, der am weitesten
   von der Verbindung seiner Enden abliegt, solange er weiter als
   `line-tolerance` abliegt.
3. Stücke, die auf derselben Geraden liegen, werden verbunden, auch über die
   Lücken hinweg, die Möbel und Türöffnungen lassen (`join-gap`) – aber nur,
   solange die gemeinsame Gerade ihre Punkte weiter trägt.
4. Stücke, die fast parallel zur vorherrschenden Richtung liegen, werden
   genau parallel dazu gedreht (`snap-angle`). Diese Richtung wird gemessen,
   nicht angenommen: Es ist die, auf die sich die längsten Wände einigen.
   Steht die Dockingstation schräg zur Wohnung, ist es eben eine schräge.

**Was die Vereinfachung nicht tut:** entscheiden, was Wand ist. Das bleibt
Sache des Belegungsgitters. Eine Linie wird nur gezeichnet, wo das Gitter sie
stützt – und genau daran scheitert, wer gerade durch den Scan läuft: Die
Strahlen der anderen Umdrehungen gingen durch die Stelle hindurch, an der die
Person stand, also zählt das Gitter die Zellen als frei, und die Linie fällt
weg. Wer stehen bleibt, ist Möbel und bleibt auf der Karte. Eine Säule bleibt
rund, weil eine Gerade durch sie ihre Punkte nicht mehr trägt. Und hinter dem
letzten gemessenen Punkt hört jede Linie auf; eine Ecke, die nie gesehen
wurde, wird nicht geschlossen.

Das ist in `test/walls.test.mjs` festgehalten, an Lidar-Aufnahmen eines
gerechneten Zimmers: vier Wände werden vier Linien, die durchlaufende Person
verschwindet, die stehende Kiste bleibt, die Säule bleibt rund, die ungesehene
Ecke bleibt offen.

Wem das zu viel Deutung ist: `walls="cells"` zeigt weiter die Zellen, die das
Gitter als Wand zählt – die rohe Evidenz, ohne jede Glättung.

![Links die Zellen, rechts dieselbe Aufzeichnung als Linien](docs/cells-vs-lines.png)

Dieselbe Aufzeichnung, links `walls="cells"` mit 158 Rechtecken, rechts der
Standard mit 26 Linien.

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

Gerechnet wird beim Laden, im Haupt-Thread. Für die Referenzaufzeichnung sind
das rund 30 ms, für einen langen Lauf mit `mapInterval 5` – 300 Scans,
85 000 Punkte – rund 120 ms: Das Gitter wächst mit der Wohnung, nicht mit der
Datenmenge, und für die Linien reichen 120 Umdrehungen, weil die übrigen
dieselben Wände noch einmal zeigen. Welche Zellen Wand sind, entscheidet
weiterhin jeder einzelne Strahl. Ein Worker lohnt nicht.

## Entwickeln und Prüfen

Die Rechnung lässt sich ohne Roboter, ohne FHEM und ohne Browser prüfen:

```sh
node --test test/session.test.mjs      # nur die Karten-Mathematik
node --test test/walls.test.mjs        # die Vereinfachung der Wände
node --test test/controls.test.mjs     # der Index für FHEMs update
```

`controls_neatomaps.txt` nennt Größe und Zeitstempel jeder Datei, und FHEM
verwirft eine Datei, deren Größe nicht auf das Byte stimmt. Nach jeder
Änderung an `www/` also:

```sh
tools/make_controls.sh
```

Wird das vergessen, schlägt `test/controls.test.mjs` fehl – dafür ist er da.
Neue Einträge in `CHANGED` gehören nach oben, vor die erste Leerzeile: FHEM
zeigt beim Update genau diesen Block an.

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
