# Progi zwalniające → WME (wspólna baza na GitHubie)

Trzy pliki, jedna baza:

| plik | co robi |
|---|---|
| `index.html` | strona: pobiera progi z OSM (Overpass), filtruje, pokazuje mapę z kolorowymi kropkami, zapisuje „dodane” |
| `progi.user.js` | userscript do Waze Map Editor: rysuje te same progi jako warstwę kropek na mapie WME |
| `data/progi.json` | baza danych: jeden plik JSON, który czytają i zapisują oba pliki wyżej |

## 1. Wrzucenie na GitHub Pages

1. Repozytorium (np. `miodeq-ofc/Hazard`) → **Settings → Pages** → *Deploy from a branch* → gałąź `main`, katalog `/ (root)`.
2. Strona będzie pod `https://<użytkownik>.github.io/<repo>/` (tu: `https://miodeq-ofc.github.io/Hazard/`).
3. W ustawieniach strony (sekcja **Wspólna baza na GitHubie**) wpisz to samo repo, gałąź i ścieżkę `data/progi.json`.

## 2. Token do zapisu

Odczyt działa bez tokenu (repo publiczne). Żeby strona i userscript **zapisywały** zmiany do `data/progi.json`, potrzebny jest token:

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens**.
2. *Repository access*: tylko to repo. *Permissions → Contents: Read and write*.
3. Wklej token w ustawieniach strony (i/lub w panelu userscriptu). Token zostaje tylko w przeglądarce (localStorage / magazyn Tampermonkey) — nie ma go w repo.

Bez tokenu strona i userscript nadal działają, tylko lokalnie (dane w przeglądarce).

## 3. Userscript

1. Zainstaluj Tampermonkey / Violentmonkey.
2. Otwórz `progi.user.js` (raw) i zainstaluj.
3. Wejdź na <https://www.waze.com/editor>. W prawym górnym rogu pojawi się panel **Progi zwalniające**:
   - kropki: pomarańczowe = do dodania, zielone = dodane, niebieskie = nowe (od 1. synchronizacji), czerwone = zniknęły z OSM,
   - **Alt + klik** na mapie przełącza „dodane” dla najbliższego progu (do 60 m),
   - **Otwórz panel** otwiera stronę i włącza natychmiastową synchronizację w obie strony.

## 4. Jak działa synchronizacja

- Każda zmiana (checkbox, Alt+klik, notatka, import) jest zapisywana ~1,5 s później do `data/progi.json` w repo.
- Konflikty: przy każdym zapisie plik jest najpierw scalany z wersją z GitHuba, a wygrywa rekord z nowszą datą (`ts`). Nic nie ginie, gdy dwie osoby klikają naraz.
- Strona ↔ userscript: gdy strona jest otwarta z panelu WME, zmiany lecą od razu przez `postMessage`. W innym wypadku oba pliki odświeżają bazę z GitHuba co 20 s.
- Osobne karty tej samej strony synchronizują się przez `BroadcastChannel`.

## 5. Co się zmieniło w tej wersji

- **Filtr miasta/gminy działa też po pobraniu całego województwa** — pobieranie województwa dociąga granice gmin (`admin_level 7/8`) i przypisuje każdemu progowi gminę/miasto po współrzędnych. Stare rekordy uzupełnią się po jednym powtórzeniu „Aktualizuj zaznaczone”.
- **Checkbox „dodane” ma 5-sekundowe okno na cofnięcie** — wiersz robi się zielony z animacją, widać „cofnij”; dopiero po 5 s trafia do „zrobionych” i wygasa.
- Mapa (Leaflet) z warstwami włączanymi w prawym górnym rogu — te same kolory co w WME.

## Ograniczenia

- Brak serwera: zapis idzie prosto do GitHuba, więc token jest w przeglądarce. Nie używaj tego na komputerze, do którego mają dostęp inne osoby.
- Repozytorium musi być publiczne, jeśli chcesz czytać bazę bez tokenu (sam plik JSON nie zawiera niczego wrażliwego).
- Overpass bywa przeciążony — przy błędzie po prostu powtórz pobieranie.
