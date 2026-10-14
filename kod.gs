// =========================================================================
// LUBAS WMS v5.60 - BACKEND SYSTEM & DASHBOARD SUITE + MODULE FOTO MWG
// Baza danych: BigQuery (lubas-prod-erp-enovoapi-0.Lubas_WMS_2)
// Kontrola Dostępów: Arkusz Google (1XO7B4t49hlOyg3yMews6rV9bkFQRUcCCHsJUIpysT2QU)
// Shared Drive Foto MWG: 1ICEK6b9DkNdzJvoomDIrgNl2efdMXMdI
// =========================================================================

var BQ_PROJECT_ID        = 'lubas-prod-erp-enovoapi-0';
var BQ_DATASET_ID        = 'Lubas_WMS_2';
var BQ_TABLE_ID          = 'wms_dataset'; 
var SPREADSHEET_USERS_ID = '1XO7B4t49hlOyg3yMews6rV9bkFQRUcCCHsJUIpysT2QU';
var SHARED_DRIVE_FOTO_ID = '1ICEK6b9DkNdzJvoomDIrgNl2efdMXMdI';

function doGet(e) {
  try {
    if (e.parameter && e.parameter.akcja === "pobierz_stan") {
      var kodTowaru = (e.parameter.kod_towaru || "").trim();
      var polka = (e.parameter.polka || "").trim().toUpperCase();
      var stan = pobierzAktualnyStan(kodTowaru, polka);
      return ContentService.createTextOutput(JSON.stringify({ status: "SUCCESS", stan: stan })).setMimeType(ContentService.MimeType.JSON);
    }
    return ContentService.createTextOutput(JSON.stringify({ status: "ERROR", message: "Brak parametrów." })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "ERROR", message: err.toString() })).setMimeType(ContentService.MimeType.JSON);
  }
}

function doPost(e) {
  try {
    zapiszLogDoArkusza("INFO", "Odebrano żądanie POST", e.postData.contents);
    var data = {};
    var surowyTekst = e.postData.contents;
    
    if (surowyTekst.indexOf("{") === 0) {
      data = JSON.parse(surowyTekst);
    } else {
      var pary = surowyTekst.split("&");
      for (var i = 0; i < pary.length; i++) {
        var k_v = pary[i].split("=");
        var klucz = decodeURIComponent(k_v[0]);
        var wartosc = k_v.length > 1 ? decodeURIComponent(k_v[1].replace(/\+/g, " ")) : "";
        data[klucz] = wartosc;
      }
    }

    // ==========================================
    // 1. WERYFIKACJA UŻYTKOWNIKA (PROSTO Z BIGQUERY)
    // ==========================================
    if (data.akcja === "weryfikuj_user") {
      var emailSearch = String(data.email || "").trim().toLowerCase();
      var hasloSearch = String(data.haslo || "").trim();
      
      try {
        var sqlUser = `
          SELECT Email, Haslo, Nazwisko_Imie, Rola, Dostepne_Magazyny, Domyslny_Magazyn
          FROM \`lubas-prod-erp-enovoapi-0.Lubas_WMS_2.wms_uzytkownicy\`
          WHERE LOWER(TRIM(Email)) = '${emailSearch}'
          LIMIT 1
        `;
        
        var resUser = BigQuery.Jobs.query({ query: sqlUser, useLegacySql: false }, BQ_PROJECT_ID);
        
        if (resUser.rows && resUser.rows.length > 0) {
          var row = resUser.rows[0].f;
          var dbHaslo = String(row[1].v || "").trim();
          
          if (dbHaslo === hasloSearch) {
            var nazwaPracownika = String(row[2].v || "").trim();
            var rolaPracownika = String(row[3].v || "operator").trim().toLowerCase();
            var dostepneMagazyny = String(row[4].v || "Magazyn pozostałe").trim();
            var domyslnyMagazyn = String(row[5].v || "Magazyn pozostałe").trim();

            return ContentService.createTextOutput(JSON.stringify({
              status: "SUCCESS",
              message: "DOZWOLONY",
              nazwa: nazwaPracownika,
              rola: rolaPracownika,
              magazyny: dostepneMagazyny,
              domyslny_magazyn: domyslnyMagazyn
            })).setMimeType(ContentService.MimeType.JSON);
          } else {
            return ContentService.createTextOutput(JSON.stringify({
              status: "ERROR",
              message: "NIEPRAWIDŁOWE_HASŁO"
            })).setMimeType(ContentService.MimeType.JSON);
          }
        } else {
          return ContentService.createTextOutput(JSON.stringify({
            status: "ERROR",
            message: "NIE_ZNALEZIONO_EMAILA"
          })).setMimeType(ContentService.MimeType.JSON);
        }
      } catch (err) {
        return ContentService.createTextOutput(JSON.stringify({
          status: "ERROR",
          message: "BŁĄD_BIGQUERY_USER: " + err.toString()
        })).setMimeType(ContentService.MimeType.JSON);
      }
    }

    // ==========================================
    // 1B. FOTODOKUMENTACJA WYSYŁKI PALET (MWG)
    // ==========================================
    if (data.akcja === "zapisz_foto_wysylke") {
      return zapiszFotoWysylke(data);
    }

    // ==========================================
    // 2. DANE DLA DASHBOARDÓW
    // ==========================================
    if (data.akcja === "pobierz_dane_dashboardu") {
      var wynikFinalny = {
        status: "SUCCESS",
        stany: [],
        braki: [],
        obszary: [],
        pracownicy: [],
        rotacja: []
      };

      try {
        try {
          var sqlStan = `SELECT * FROM \`lubas-prod-erp-enovoapi-0.Lubas_WMS_2.v_pelny_stan_magazynu\` LIMIT 2000`;
          var resStan = BigQuery.Jobs.query({ query: sqlStan, useLegacySql: false }, BQ_PROJECT_ID);
          wynikFinalny.stany = parsujWynikiBQ(resStan);
        } catch(eA) { zapiszLogDoArkusza("ERROR", "Błąd pobierania stanów BQ", eA.toString()); }

        try {
          var sqlBraki = `SELECT * FROM \`lubas-prod-erp-enovoapi-0.Lubas_WMS_2.v_aktualne_braki_magazynowe\` LIMIT 1000`;
          var resBraki = BigQuery.Jobs.query({ query: sqlBraki, useLegacySql: false }, BQ_PROJECT_ID);
          wynikFinalny.braki = parsujWynikiBQ(resBraki);
        } catch(eB) { zapiszLogDoArkusza("ERROR", "Błąd pobierania braków BQ", eB.toString()); }

        try {
          var sqlObszary = `
            SELECT 
              w.do_lokalizacji AS obszar, 
              SUM(w.ilosc) AS suma_sztuk, 
              COUNT(1) AS ilosc_operacji,
              SUM(w.ilosc * COALESCE(s.cena_jednostkowa, 0)) AS wartosc_pln
            FROM \`lubas-prod-erp-enovoapi-0.Lubas_WMS_2.wms_dataset\` w
            LEFT JOIN \`lubas-prod-erp-enovoapi-0.Lubas_WMS_2.v_pelny_stan_magazynu\` s 
              ON UPPER(TRIM(w.towar)) = UPPER(TRIM(s.towar))
            WHERE UPPER(TRIM(w.typ)) LIKE '%WYDANIE%' OR UPPER(TRIM(w.typ)) LIKE '%REGAŁ%'
            GROUP BY obszar
            ORDER BY wartosc_pln DESC
            LIMIT 15
          `;
          var resObszary = BigQuery.Jobs.query({ query: sqlObszary, useLegacySql: false }, BQ_PROJECT_ID);
          wynikFinalny.obszary = parsujWynikiBQ(resObszary);
        } catch(eC) { zapiszLogDoArkusza("ERROR", "Błąd pobierania obszarów BQ", eC.toString()); }

        try {
          var sqlPracownicy = `
            SELECT 
              TRIM(w.pracownik) AS pracownik, 
              SUM(w.ilosc) AS suma_pobrano, 
              COUNT(1) AS ilosc_wydan,
              SUM(w.ilosc * COALESCE(s.cena_jednostkowa, 0)) AS wartosc_pln
            FROM \`lubas-prod-erp-enovoapi-0.Lubas_WMS_2.wms_dataset\` w
            LEFT JOIN \`lubas-prod-erp-enovoapi-0.Lubas_WMS_2.v_pelny_stan_magazynu\` s 
              ON UPPER(TRIM(w.towar)) = UPPER(TRIM(s.towar))
            WHERE UPPER(TRIM(w.typ)) = 'WYDANIE OSOBA'
              AND w.pracownik IS NOT NULL 
              AND TRIM(w.pracownik) != ''
            GROUP BY pracownik
            ORDER BY wartosc_pln DESC
            LIMIT 15
          `;
          var resPracownicy = BigQuery.Jobs.query({ query: sqlPracownicy, useLegacySql: false }, BQ_PROJECT_ID);
          wynikFinalny.pracownicy = parsujWynikiBQ(resPracownicy);
        } catch(eD) { zapiszLogDoArkusza("ERROR", "Błąd pobierania pracowników BQ", eD.toString()); }

        try {
          var sqlRotacja = `
            SELECT 
              w.towar AS kod,
              COALESCE(s.nazwa_towaru, s.Kod_enova, w.towar) AS nazwa,
              COUNT(1) AS ilosc_pobran,
              SUM(w.ilosc) AS suma_sztuk,
              SUM(w.ilosc * COALESCE(s.cena_jednostkowa, 0)) AS wartosc_pln
            FROM \`lubas-prod-erp-enovoapi-0.Lubas_WMS_2.wms_dataset\` w
            LEFT JOIN \`lubas-prod-erp-enovoapi-0.Lubas_WMS_2.v_pelny_stan_magazynu\` s 
              ON UPPER(TRIM(w.towar)) = UPPER(TRIM(s.towar))
            WHERE UPPER(TRIM(w.typ)) LIKE '%WYDANIE%' OR UPPER(TRIM(w.typ)) LIKE '%REGAŁ%'
            GROUP BY kod, nazwa
            ORDER BY suma_sztuk DESC
            LIMIT 15
          `;
          var resRotacja = BigQuery.Jobs.query({ query: sqlRotacja, useLegacySql: false }, BQ_PROJECT_ID);
          wynikFinalny.rotacja = parsujWynikiBQ(resRotacja);
        } catch(eE) { zapiszLogDoArkusza("ERROR", "Błąd pobierania rotacji BQ", eE.toString()); }

        return ContentService.createTextOutput(JSON.stringify(wynikFinalny)).setMimeType(ContentService.MimeType.JSON);

      } catch (errBQ) {
        return ContentService.createTextOutput(JSON.stringify({ status: "ERROR", message: "Błąd łączny BigQuery: " + errBQ.toString() })).setMimeType(ContentService.MimeType.JSON);
      }
    }

    // ==========================================
    // 3. SPRAWDZANIE STANU TOWARU WE WSZYSTKICH LOKALIZACJACH
    // ==========================================
    if (data.akcja === "sprawdz_lokalizacje_towaru") {
      var kodTowaruSearch = (data.kod_towaru || "").trim().toUpperCase();
      
      var sqlNazwa = `
        SELECT Nazwa_WMS 
        FROM \`lubas-prod-erp-enovoapi-0.Lubas_WMS_2.Towary_kod_P\`
        WHERE UPPER(TRIM(Kod_WMS)) = '${kodTowaruSearch}'
          AND Nazwa_WMS IS NOT NULL 
          AND TRIM(Nazwa_WMS) != ''
        ORDER BY LENGTH(Nazwa_WMS) DESC
        LIMIT 1
      `;
      var resNazwa = BigQuery.Jobs.query({ query: sqlNazwa, useLegacySql: false }, BQ_PROJECT_ID);
      var nazwa = (resNazwa.rows && resNazwa.rows.length > 0 && resNazwa.rows[0].f[0].v !== null) ? String(resNazwa.rows[0].f[0].v).trim() : "Brak opisu w bazie";

      var sqlPolki = `
        WITH Ruchy AS (
          SELECT do_lokalizacji AS polka, ilosc AS zmiana FROM \`lubas-prod-erp-enovoapi-0.Lubas_WMS_2.wms_dataset\` WHERE UPPER(TRIM(towar)) = '${kodTowaruSearch}'
          UNION ALL
          SELECT z_lokalizacji AS polka, -ilosc AS zmiana FROM \`lubas-prod-erp-enovoapi-0.Lubas_WMS_2.wms_dataset\` WHERE UPPER(TRIM(towar)) = '${kodTowaruSearch}'
        )
        SELECT polka, SUM(zmiana) AS stan
        FROM Ruchy
        WHERE UPPER(polka) NOT IN ('DOSTAWCA', 'PRODUKCJA')
        GROUP BY polka
        HAVING stan > 0
        ORDER BY stan DESC
      `;
      var resPolki = BigQuery.Jobs.query({ query: sqlPolki, useLegacySql: false }, BQ_PROJECT_ID);
      
      var lokalizacje = [];
      var sumaOgolna = 0;
      
      if (resPolki.rows && resPolki.rows.length > 0) {
        for (var i = 0; i < resPolki.rows.length; i++) {
          var p = String(resPolki.rows[i].f[0].v);
          var s = parseFloat(resPolki.rows[i].f[1].v) || 0;
          lokalizacje.push({ polka: p, ilosc: s });
          sumaOgolna += s;
        }
      }

      return ContentService.createTextOutput(JSON.stringify({
        status: "SUCCESS",
        kod: kodTowaruSearch,
        nazwa: nazwa,
        suma: sumaOgolna,
        lokalizacje: lokalizacje
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // ==========================================
    // 4. POBIERANIE NAZWY I JEDNOSTKI MIARY
    // ==========================================
    if (data.akcja === "pobierz_nazwe_towaru") {
      var kodTowaruSearch = (data.kod_towaru || "").trim().toUpperCase();
      var cache = CacheService.getScriptCache();
      var cacheKey = "JM_" + kodTowaruSearch;
      var cachedData = cache.get(cacheKey);

      if (cachedData !== null) {
        var parsed = JSON.parse(cachedData);
        return ContentService.createTextOutput(JSON.stringify({ 
          status: "SUCCESS", 
          nazwa: parsed.nazwa, 
          jednostka: parsed.jednostka 
        })).setMimeType(ContentService.MimeType.JSON);
      }

      var sqlQuery = `
        SELECT 
          Nazwa_WMS, 
          COALESCE(TRIM(Jednostka_miary), 'szt.') AS jm 
        FROM \`lubas-prod-erp-enovoapi-0.Lubas_WMS_2.Towary_kod_P\`
        WHERE UPPER(TRIM(Kod_WMS)) = '${kodTowaruSearch}'
          AND Nazwa_WMS IS NOT NULL 
          AND TRIM(Nazwa_WMS) != ''
        ORDER BY LENGTH(Nazwa_WMS) DESC
        LIMIT 1
      `;
      var res = BigQuery.Jobs.query({ query: sqlQuery, useLegacySql: false }, BQ_PROJECT_ID);
      var rows = res.rows;
      var nazwa = "";
      var jednostka = "szt.";

      if (rows && rows.length > 0) {
        if (rows[0].f[0].v !== null) nazwa = String(rows[0].f[0].v).trim();
        if (rows[0].f[1] && rows[0].f[1].v !== null && String(rows[0].f[1].v).trim() !== "") {
          jednostka = String(rows[0].f[1].v).trim();
        }
      }

      var payload = { nazwa: nazwa, jednostka: jednostka };
      cache.put(cacheKey, JSON.stringify(payload), 21600);

      return ContentService.createTextOutput(JSON.stringify({ 
        status: "SUCCESS", 
        nazwa: nazwa, 
        jednostka: jednostka 
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // ==========================================
    // 5. OBSŁUGA KOLEJKI DRUKU
    // ==========================================
    if (data.akcja === "dodaj_do_kolejki") {
      var idZadania = dodajDoKolejkiDruku(data.zpl);
      return ContentService.createTextOutput(JSON.stringify({ status: "SUCCESS", id: idZadania })).setMimeType(ContentService.MimeType.JSON);
    }

    if (data.akcja === "pobierz_kolejke") {
      var zplKod = pobierzINastepnyWydruk();
      return ContentService.createTextOutput(JSON.stringify({ zpl: zplKod })).setMimeType(ContentService.MimeType.JSON);
    }
    
    // ==========================================
    // 6. OPERACJA ZAPISU RUCHU WMS
    // ==========================================
    var towarRaw = (data.towar || "").trim().toUpperCase();
    if (!/^[A-Z]\d{5}$/.test(towarRaw)) {
      throw new Error("Nieprawidłowy kod towaru: '" + towarRaw + "'. Wymagana litera + 5 cyfr.");
    }
    var towar = towarRaw;

    var typOperacji = (data.typ || "PRZYJĘCIE").toUpperCase();
    var zLokalizacji = (data.Z_Lokalizacji || "").trim();
    var doLokalizacji = (data.Do_Lokalizacji || "").trim();
    var lokalizacjaRegex = /^\d{2}-\d{2}-\d{2}-[A-Za-z]-\d{2}$/;

    if (typOperacji !== "PRZYJĘCIE" && !lokalizacjaRegex.test(zLokalizacji)) {
      throw new Error("Półka źródłowa musi mieć format: 00-00-00-A-00.");
    }

    if (typOperacji === "PRZYJĘCIE" || typOperacji === "PRZESUNIĘCIE") {
      if (!lokalizacjaRegex.test(doLokalizacji)) {
        throw new Error("Lokalizacja docelowa musi mieć format: 00-00-00-A-00.");
      }
    } else if (typOperacji === "WYDANIE REGAŁ" || typOperacji === "WYDANIE (REGAŁ)") {
      if (!doLokalizacji || doLokalizacji.length < 2) {
        throw new Error("Wymagane podanie nazwy regału/strefy docelowej.");
      }
    }

    var pracownikSurowy = (data.pracownik || data.operator || "").trim();
    if (pracownikSurowy.indexOf("@") !== -1) {
      pracownikSurowy = pracownikSurowy.split("@")[0].replace(/\./g, " ");
    }
    pracownikSurowy = pracownikSurowy.replace(/[^a-zA-Zà-žÀ-Ž\s-]/g, "").replace(/\s+/g, " ").trim();
    var czesciImienia = pracownikSurowy.split(" ");
    if (czesciImienia.length < 2 || czesciImienia[0].length < 2 || czesciImienia[1].length < 2) {
      throw new Error("Nieprawidłowe dane pracownika: Wymagane pełne imię i nazwisko.");
    }
    var pracownik = czesciImienia.map(function(slowo) {
      return slowo.charAt(0).toUpperCase() + slowo.slice(1).toLowerCase();
    }).join(" ");

    var teraz = new Date(new Date().getTime() + (2 * 60 * 60 * 1000));
    var isoZlokalizowany = teraz.toISOString().replace('T', ' ').substring(0, 19);

    var idRuchu = "RUCH-" + Utilities.formatDate(teraz, "GMT", "yyyyMMdd-HHmmss");
    var ilosc = parseFloat(data.ilosc) || 1.0;
    var operator = data.operator || "";

    var wiersz = {
      insertId: idRuchu,
      json: {
        id_ruchu: String(idRuchu),
        data_czas: isoZlokalizowany,
        operator: String(operator),
        typ: String(typOperacji).toUpperCase(),
        towar: String(towar),
        ilosc: ilosc,
        z_lokalizacji: String(zLokalizacji).toUpperCase(),
        do_lokalizacji: String(doLokalizacji).toUpperCase(),
        pracownik: String(pracownik)
      }
    };

    var polkaDoArkusza = (wiersz.json.typ === "PRZYJĘCIE") ? wiersz.json.do_lokalizacji : wiersz.json.z_lokalizacji;
    if (wiersz.json.typ !== "PRZYJĘCIE") {
      var aktualnyStan = pobierzAktualnyStan(wiersz.json.towar, polkaDoArkusza);
      if (aktualnyStan < ilosc) {
        throw new Error("Brak wystarczającej ilości towaru na półce " + polkaDoArkusza + ". Dostępne: " + aktualnyStan);
      }
    }

    var dataLoad = { rows: [wiersz] };
    var odpowiedzBQ = BigQuery.Tabledata.insertAll(dataLoad, BQ_PROJECT_ID, BQ_DATASET_ID, BQ_TABLE_ID);
    
    if (odpowiedzBQ.insertErrors && odpowiedzBQ.insertErrors.length > 0) {
      throw new Error("BigQuery insert error: " + JSON.stringify(odpowiedzBQ.insertErrors));
    }

    aktualizujArkuszStanow(wiersz.json.towar, polkaDoArkusza, wiersz.json.typ, wiersz.json.ilosc);
    
    return ContentService.createTextOutput(JSON.stringify({ status: "SUCCESS", id_ruchu: idRuchu })).setMimeType(ContentService.MimeType.JSON);
                         
  } catch (error) {
    zapiszLogDoArkusza("ERROR", "Wyjątek w doPost", error.toString());
    return ContentService.createTextOutput(JSON.stringify({ status: "ERROR", message: error.toString() })).setMimeType(ContentService.MimeType.JSON);
  }
}

// =========================================================================
// STRUKTURA FOLDERÓW: ROK / MIESIĄC / NUMER_ZAMÓWIENIA + DATA W NAZWIE PLIKU
// =========================================================================
function zapiszFotoWysylke(data) {
  var logDetails = [];
  try {
    logDetails.push("Rozpoczęto zapis foto-wysyłki dla magazynu: " + (data.magazyn || "MWG"));
    
    var nrZamowienia = String(data.numer_zamowienia || "").trim();
    if (!nrZamowienia) throw new Error("Brak numeru zamówienia.");
    
    logDetails.push("Zamówienie: " + nrZamowienia);

    var plikiFoto = [];
    if (typeof data.zdjecia === "string") {
      try {
        plikiFoto = JSON.parse(data.zdjecia);
        logDetails.push("Sparsowano JSON zdjęć. Łącznie sztuk: " + plikiFoto.length);
      } catch (eJson) {
        logDetails.push("Błąd JSON parse zdjęć: " + eJson.toString());
        throw new Error("Nieprawidłowy ciąg JSON zdjęć.");
      }
    } else if (Array.isArray(data.zdjecia)) {
      plikiFoto = data.zdjecia;
      logDetails.push("Odebrano tablicę zdjęć. Łącznie sztuk: " + plikiFoto.length);
    }

    if (!plikiFoto || plikiFoto.length === 0) throw new Error("Tablica zdjęć jest pusta.");

    // Parsowanie ROK/MIESIĄC z formatu ZO/012/1/01/26
    var rokFolder = "2026";
    var miesiacFolder = "01";
    var czesciZam = nrZamowienia.split("/");
    if (czesciZam.length >= 5) {
      miesiacFolder = czesciZam[3];
      rokFolder = "20" + czesciZam[4];
    } else {
      var terazD = new Date();
      rokFolder = String(terazD.getFullYear());
      miesiacFolder = ("0" + (terazD.getMonth() + 1)).slice(-2);
    }

    var zamCzyste = nrZamowienia.replace(/[\/\\?%*:|"<>]/g, "-");
    logDetails.push("Struktura docelowa: " + rokFolder + " / " + miesiacFolder + " / " + zamCzyste);

    // Tworzenie hierarchii folderów: Główny -> Rok -> Miesiąc -> Podfolder Zamówienia
    var mainFolder = DriveApp.getFolderById(SHARED_DRIVE_FOTO_ID);
    var folderRok = pobierzLUBStworzFolder(mainFolder, rokFolder);
    var folderMiesiac = pobierzLUBStworzFolder(folderRok, miesiacFolder);
    var folderZamowienia = pobierzLUBStworzFolder(folderMiesiac, zamCzyste);

    var terazTime = Utilities.formatDate(new Date(), "GMT+2", "yyyyMMdd_HHmmss");
    var linkiZdjec = [];

    for (var i = 0; i < plikiFoto.length; i++) {
      var rawBase64 = String(plikiFoto[i] || "").trim();
      if (!rawBase64) continue;

      if (rawBase64.indexOf(",") !== -1) {
        rawBase64 = rawBase64.split(",")[1];
      }

      rawBase64 = rawBase64.replace(/ /g, "+");

      try {
        var decodedBytes = Utilities.base64Decode(rawBase64);
        var nazwaPliku = zamCzyste + "_" + terazTime + "_FOTO_" + (i + 1) + ".jpg";
        var blob = Utilities.newBlob(decodedBytes, "image/jpeg", nazwaPliku);
        var file = folderZamowienia.createFile(blob);
        linkiZdjec.push(file.getUrl());
        logDetails.push("Plik " + (i + 1) + " zapisany na Drive: " + nazwaPliku);
      } catch (errDecode) {
        var dtl = "Błąd dekodowania pliku #" + (i + 1) + ": " + errDecode.toString() + " | Długość: " + rawBase64.length;
        logDetails.push(dtl);
        zapiszLogDoArkusza("ERROR", "ZapisFoto_DecodeError", dtl);
        throw new Error(dtl);
      }
    }

    var terazBQ = new Date(new Date().getTime() + (2 * 60 * 60 * 1000)).toISOString().replace('T', ' ').substring(0, 19);
    var idWysylki = "WYS-" + Utilities.formatDate(new Date(), "GMT", "yyyyMMdd-HHmmss");
    var operator = String(data.operator || "");
    var pracownik = String(data.pracownik || operator);
    var magazyn = String(data.magazyn || "Magazyn Wyrobów Gotowych");

    var sqlInsert = `
      INSERT INTO \`lubas-prod-erp-enovoapi-0.Lubas_WMS_2.wms_wysylki_fotodokumentacja\`
      (id_wysylki, data_czas, numer_zamowienia, pracownik, operator, magazyn, ilosc_zdjec, folder_drive_url, linki_do_zdjec)
      VALUES (
        '${idWysylki}',
        DATETIME '${terazBQ}',
        '${nrZamowienia}',
        '${pracownik}',
        '${operator}',
        '${magazyn}',
        ${linkiZdjec.length},
        '${folderZamowienia.getUrl()}',
        '${linkiZdjec.join("; ")}'
      )
    `;

    BigQuery.Jobs.query({ query: sqlInsert, useLegacySql: false }, BQ_PROJECT_ID);
    logDetails.push("Wpis dodany do BQ: " + idWysylki);
    zapiszLogDoArkusza("INFO", "ZapisFoto_Success", logDetails.join(" | "));

    return ContentService.createTextOutput(JSON.stringify({
      status: "SUCCESS",
      id_wysylki: idWysylki,
      folder_url: folderZamowienia.getUrl(),
      ilosc: linkiZdjec.length,
      logi: logDetails
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    logDetails.push("BŁĄD KRYTYCZNY: " + err.toString());
    zapiszLogDoArkusza("ERROR", "ZapisFoto_Exception", logDetails.join(" | "));
    return ContentService.createTextOutput(JSON.stringify({
      status: "ERROR",
      message: err.toString(),
      szczegoly: logDetails
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

function pobierzLUBStworzFolder(parentFolder, nazwaFolderu) {
  var folders = parentFolder.getFoldersByName(nazwaFolderu);
  if (folders.hasNext()) {
    return folders.next();
  } else {
    return parentFolder.createFolder(nazwaFolderu);
  }
}

function parsujWynikiBQ(queryResult) {
  var wynik = [];
  if (queryResult && queryResult.rows) {
    var fields = queryResult.schema.fields;
    for (var i = 0; i < queryResult.rows.length; i++) {
      var obj = {};
      for (var j = 0; j < queryResult.rows[i].f.length; j++) {
        obj[fields[j].name] = queryResult.rows[i].f[j].v !== null ? queryResult.rows[i].f[j].v : "";
      }
      wynik.push(obj);
    }
  }
  return wynik;
}

function dodajDoKolejkiDruku(zplKod) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("KOLEJKA_DRUKU") || ss.insertSheet("KOLEJKA_DRUKU");
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(["ID_ZADANIA", "DATA_CZAS", "ZPL", "STATUS"]);
  }
  var id = "PRN-" + Utilities.formatDate(new Date(), "GMT+2", "yyyyMMdd-HHmmss-SSS");
  var dataCzas = Utilities.formatDate(new Date(), "GMT+2", "yyyy-MM-dd HH:mm:ss");
  sheet.appendRow([id, dataCzas, zplKod, "OCZEKUJE"]);
  return id;
}

function pobierzINastepnyWydruk() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("KOLEJKA_DRUKU");
  if (!sheet) return "";
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][3] === "OCZEKUJE") {
      var zplKod = data[i][2];
      sheet.deleteRow(i + 1);
      return zplKod;
    }
  }
  return "";
}

function pobierzAktualnyStan(kod, polka) {
  try {
    var sqlQuery = `
      WITH RuchyNaPolce AS (
        SELECT ilosc AS zmiana FROM \`lubas-prod-erp-enovoapi-0.Lubas_WMS_2.wms_dataset\`
        WHERE UPPER(TRIM(towar)) = '${kod}' AND UPPER(TRIM(do_lokalizacji)) = '${polka}'
        UNION ALL
        SELECT -ilosc AS zmiana FROM \`lubas-prod-erp-enovoapi-0.Lubas_WMS_2.wms_dataset\`
        WHERE UPPER(TRIM(towar)) = '${kod}' AND UPPER(TRIM(z_lokalizacji)) = '${polka}'
      )
      SELECT COALESCE(SUM(zmiana), 0) AS stan FROM RuchyNaPolce
    `;
    var res = BigQuery.Jobs.query({ query: sqlQuery, useLegacySql: false }, BQ_PROJECT_ID);
    if (res.rows && res.rows.length > 0 && res.rows[0].f[0].v !== null) {
      return parseFloat(res.rows[0].f[0].v) || 0;
    }
    return 0;
  } catch (err) {
    return 0;
  }
}

function zapiszLogDoArkusza(status, akcja, szczegoly) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("LOGI SCRIPTU") || ss.insertSheet("LOGI SCRIPTU");
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(["DATA I GODZINA", "STATUS", "AKCJA", "SZCZEGÓŁY / DANE JSON"]);
    }
    sheet.appendRow([new Date(), status, akcja, szczegoly]);
  } catch (e) {}
}

function aktualizujArkuszStanow(kod, polka, typ, ilosc) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("STAN AKTUALNY") || ss.insertSheet("STAN AKTUALNY");
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(["KOD TOWARU", "PÓŁKA / LOKALIZACJA", "STAN AKTUALNY"]);
    }
    var dane = sheet.getDataRange().getValues();
    var zmiana = (typ === "PRZYJĘCIE") ? parseFloat(ilosc) : -parseFloat(ilosc);
    var znaleziono = false;
    for (var i = 1; i < dane.length; i++) {
      if (dane[i][0] == kod && dane[i][1] == polka) {
        var staryStan = parseFloat(dane[i][2]) || 0;
        var nowyStan = staryStan + zmiana;
        if (nowyStan < 0) nowyStan = 0;
        sheet.getRange(i + 1, 3).setValue(nowyStan);
        znaleziono = true;
        break;
      }
    }
    if (!znaleziono && typ === "PRZYJĘCIE") {
      sheet.appendRow([kod, polka, ilosc]);
    }
  } catch (err) {}
}