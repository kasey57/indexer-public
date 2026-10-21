# Indexing Public

Samodzielnie hostowana aplikacja do wysyłania adresów URL do Google Indexing API. Interfejs jest po polsku. Można zgłaszać adresy pojedynczo lub listami, importować mapy witryn, przeglądać i eksportować historię oraz zarządzać kolejką zgłoszeń.

## Co robi aplikacja

- Przyjmuje adresy URL albo pobiera je z mapy witryny i wysyła zgłoszenia do Google Indexing API.
- Zapisuje historię zgłoszeń i dane potrzebne do obsługi kolejki.
- Kolejkuje zgłoszenia, których nie można wysłać od razu z powodu dziennego limitu Google API. Kolejkę można przetworzyć z interfejsu albo przez harmonogram zadań na własnym serwerze.
- Pozwala przeszukiwać historię, filtrować ją, eksportować do CSV oraz usuwać wpisy z historii i kolejki.
- Oferuje tryb prywatny: zgłoszenie nie zapisuje historii ani klucza Google w bazie, a niewysłane z powodu limitu adresy nie trafiają do kolejki.
- Nie ma kont użytkowników ani logowania. Jest to aplikacja dla jednej zaufanej instancji.

Widoczne liczniki limitu zostały usunięte z interfejsu. Logika serwera nadal uwzględnia limit Google API i kolejkę; usunięcie licznika nie zwiększa limitów Google.

## Wymagania

- Node.js 20 lub nowszy.
- Projekt Google Cloud z włączonym **Google Indexing API**.
- Konto usługi Google oraz jego klucz JSON. Dla każdej obsługiwanej domeny adres e-mail konta usługi musi mieć uprawnienia właściciela w Google Search Console.
- Jedna z baz: SQLite (domyślnie) albo MySQL.

## Instalacja lokalna

```bash
git clone https://github.com/TWOJA-NAZWA/indexing-public.git
cd indexing-public
npm install
npm start
```

Otwórz `http://localhost:3000`. Serwer korzysta z portu ustawionego w `PORT` (domyślnie `3000`). Backend i interfejs są uruchamiane razem przez `server.js`.

Skopiuj `.env.example` do `.env`, a następnie ustaw potrzebne zmienne w środowisku uruchomieniowym. Wbudowany serwer nie wczytuje pliku `.env` samodzielnie; użyj menedżera zmiennych środowiskowych albo narzędzia, które wczytuje ten plik.

## Jak działa baza danych

Aplikacja ma warstwę dostępu do bazy w `api/db.js`. Wybór sterownika nie zmienia funkcji interfejsu ani formatu danych używanego przez API.

### SQLite — domyślna baza lokalna

SQLite nie wymaga osobnego serwera. Przy pierwszym uruchomieniu aplikacja tworzy katalog nadrzędny i plik bazy, a następnie inicjalizuje tabele. Domyślna ścieżka to `data/indexing.sqlite` względem katalogu projektu. Można wskazać inną ścieżkę bezwzględną przez `SQLITE_PATH`.

W pliku bazy przechowywane są historia zgłoszeń, adresy URL powiązane z historią, kolejka oraz zapisane dane konta usługi Google. Zwykły tryb może zapisać klucz Google w bazie, aby używać go ponownie dla domeny. Tryb prywatny pomija zapis tych danych dla danego zgłoszenia. Plik SQLite zawiera więc potencjalnie wrażliwe dane: ogranicz dostęp do pliku i katalogu, nie dodawaj lokalnej bazy ani kopii zapasowych do publicznego repozytorium.

Dane lokalne pozostają w pliku po zatrzymaniu i ponownym uruchomieniu serwera. Wykonuj kopie zapasowe pliku, najlepiej po zatrzymaniu aplikacji albo przy użyciu narzędzia obsługującego bezpieczne kopie SQLite. Przywrócenie kopii polega na odtworzeniu pliku bazy we właściwej lokalizacji.

```env
DB_DRIVER=sqlite
SQLITE_PATH=./data/indexing.sqlite
```

### MySQL

MySQL działa jako osobny serwer bazy. Utwórz pustą bazę, wykonaj w niej jednorazowo [`schema.sql`](./schema.sql), a potem skonfiguruj połączenie:

```env
DB_DRIVER=mysql
DB_HOST=adres-serwera-bazy
DB_PORT=3306
DB_NAME=nazwa-bazy
DB_USER=uzytkownik-bazy
DB_PASSWORD=haslo-bazy
DB_SSL=true
```

`DB_SSL=true` włącza TLS. Ustaw `false` tylko wtedy, gdy serwer bazy celowo nie używa szyfrowania. Nie zapisuj haseł ani pliku `.env` w repozytorium.

Jeśli `DB_DRIVER` nie jest ustawione, ale ustawiono `DB_HOST`, aplikacja wybierze MySQL. W pozostałych przypadkach domyślnie użyje SQLite.

## Konfiguracja Google Indexing API

1. W Google Cloud Console wybierz lub utwórz projekt i włącz Google Indexing API.
2. Utwórz konto usługi i pobierz jego klucz JSON.
3. Zweryfikuj domenę w Google Search Console i dodaj adres e-mail konta usługi jako właściciela.
4. W aplikacji wgraj klucz JSON przy pierwszym zgłoszeniu dla domeny. W zwykłym trybie aplikacja może przechować klucz w bazie i użyć go ponownie.
5. Wybierz tryb prywatny, jeżeli nie chcesz zapisywać klucza ani historii danego zgłoszenia. W tym trybie klucz trzeba podać ponownie przy kolejnych operacjach.

Google ogranicza dostępność Indexing API do określonych typów treści. Przyjęcie zgłoszenia przez API nie gwarantuje zaindeksowania strony.

## Uruchomienie na własnym serwerze

Aplikacja działa jako zwykły, stale uruchomiony proces Node.js. `server.js` obsługuje zarówno interfejs, jak i ścieżkę `/api`; nie wymaga osobnego serwera frontendu ani kroku budowania.

1. Skopiuj projekt lub pobierz repozytorium na serwer z Node.js. Nie kopiuj katalogu `node_modules` z innego komputera — zależności natywne muszą pasować do systemu i wersji Node.js serwera.
2. W katalogu projektu wykonaj `npm ci --omit=dev`.
3. Skonfiguruj zmienne środowiskowe z `.env.example`. Wybierz SQLite z plikiem na trwałym dysku albo MySQL z przygotowanym schematem.
4. Uruchom `npm start`. Proces musi mieć prawo odczytu plików aplikacji, a przy SQLite także zapisu w katalogu bazy.
5. Skonfiguruj menedżer procesów lub usługę systemową, aby aplikacja uruchamiała się po restarcie serwera. Ustaw katalog roboczy na katalog projektu i przekaż zmienne środowiskowe do procesu Node.js.
6. Podłącz domenę przez reverse proxy z HTTPS, przekazując ruch do portu ustawionego w `PORT`. Zarówno `/`, jak i `/api` muszą trafiać do tego samego procesu.

Przykładowe uruchomienie na Linuxie z SQLite i zmiennymi ustawionymi bezpośrednio w środowisku:

```bash
PORT=3000 DB_DRIVER=sqlite SQLITE_PATH=/var/lib/indexing-public/indexing.sqlite npm start
```

Najpierw utwórz katalog `/var/lib/indexing-public` i nadaj użytkownikowi uruchamiającemu aplikację prawo zapisu. Możesz wybrać inną trwałą lokalizację. Przy kontenerach katalog bazy musi być podłączony jako trwały wolumen. W konfiguracji z wieloma instancjami korzystaj ze wspólnej bazy MySQL.

### Przetwarzanie kolejki

Przycisk w interfejsie uruchamia kolejkę ręcznie. Aby wykonywać to automatycznie, skonfiguruj systemowy cron lub inny harmonogram na serwerze; aplikacja nie tworzy harmonogramu samodzielnie.

Ustaw opcjonalny `CRON_SECRET` na losowy sekret o długości co najmniej 16 znaków i uruchom ponownie proces aplikacji. Harmonogram powinien wywoływać `GET /api?action=process-queue` z nagłówkiem `Authorization: Bearer <sekret>`. To standardowe żądanie HTTP; przykład dla harmonogramu na tym samym serwerze, który ma dostęp do zmiennej `CRON_SECRET`:

```bash
curl --fail --silent --show-error \
  --header "Authorization: Bearer ${CRON_SECRET}" \
  'http://127.0.0.1:3000/api?action=process-queue'
```

Przekaż sekret także do środowiska zadania albo do chronionej konfiguracji narzędzia HTTP. Nie zapisuj go w repozytorium. Dostosuj port oraz godzinę zadania do konfiguracji i strefy czasowej serwera. Bez sekretu lub z niepoprawnym nagłówkiem żądanie GET jest odrzucane. Ręczna obsługa kolejki pozostaje dostępna przez interfejs; `CRON_SECRET` nie zastępuje kontroli dostępu do aplikacji.

## Bezpieczeństwo i prywatność

Ta publiczna edycja nie ma logowania ani kontroli dostępu w aplikacji. Osoba, która może otworzyć jej adres, może przeglądać i usuwać wspólną historię, wysyłać zgłoszenia, zarządzać kolejką oraz korzystać z zapisanych kluczy Google. Tryb prywatny dotyczy zapisu konkretnego zgłoszenia; nie zabezpiecza całej aplikacji.

Przed udostępnieniem instancji ogranicz dostęp na poziomie serwera lub sieci, np. przez VPN albo uwierzytelnianie w reverse proxy. Nie wgrywaj kluczy Google do instancji dostępnej dla niezaufanych osób. Traktuj plik SQLite, bazę MySQL i ich kopie zapasowe jako dane wrażliwe.

## Zmienne środowiskowe

| Zmienna | Wymagana | Opis |
|---|---|---|
| `DB_DRIVER` | Nie | `sqlite` albo `mysql`. Domyślnie `sqlite`, chyba że ustawiono `DB_HOST`. |
| `SQLITE_PATH` | Nie | Ścieżka do pliku SQLite; domyślnie `./data/indexing.sqlite`. |
| `DB_HOST` | MySQL | Host serwera bazy. |
| `DB_PORT` | Nie | Port MySQL; domyślnie `3306`. |
| `DB_NAME` | MySQL | Nazwa bazy danych. |
| `DB_USER` | MySQL | Użytkownik bazy danych. |
| `DB_PASSWORD` | MySQL | Hasło użytkownika bazy. |
| `DB_SSL` | Nie | `true`, aby włączyć TLS dla MySQL. |
| `CRON_SECRET` | Opcjonalny harmonogram | Sekret w nagłówku Bearer autoryzujący żądania GET przetwarzające kolejkę. |
| `PORT` | Nie | Port serwera HTTP; domyślnie `3000`. |

## Rozwiązywanie problemów

- **Nie działa instalacja `better-sqlite3`:** SQLite używa natywnego modułu Node.js. Jeśli `npm install` zgłasza błąd kompilacji, sprawdź, czy instalujesz zależności dla swojej wersji Node.js i czy system ma wymagane narzędzia do budowania natywnych modułów. Alternatywnie skonfiguruj MySQL.
- **Strona się otwiera, ale historia/API nie działa:** sprawdź logi serwera, wartość `DB_DRIVER`, ścieżkę `SQLITE_PATH` lub ustawienia połączenia MySQL. Samo wczytanie strony nie potwierdza, że baza działa.
- **Dane SQLite zniknęły:** upewnij się, że aplikacja uruchamia się z oczekiwanego katalogu roboczego albo ustaw `SQLITE_PATH` bezwzględną ścieżką. Sprawdź, czy katalog bazy znajduje się na trwałym dysku i czy proces ma prawo do zapisu.
- **Kolejka nie jest wysyłana automatycznie:** sprawdź systemowy harmonogram, adres i port aplikacji, przekazanie `CRON_SECRET` do procesu serwera oraz zadania, nagłówek Bearer i logi serwera. Kolejkę można też przetworzyć z poziomu aplikacji.

## Licencja

Przed publicznym udostępnieniem repozytorium dodaj plik licencji wybranej dla projektu.
