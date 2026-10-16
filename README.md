# Venetocore · Magazzino

Gestione interna della scorta magliette. Sito statico su GitHub Pages, dati su Supabase.

## Come funziona
- `index.html`, `style.css`, `app.js`: il sito, ottimizzato per telefono (si può aggiungere alla schermata Home).
- `config.js`: URL e chiave pubblica di Supabase. Se sono vuoti il sito gira in **modalità prova** con i dati salvati solo nel browser.
- `supabase/schema.sql`: tabelle, regole di accesso, funzioni per scalare/aggiungere pezzi in modo sicuro, bucket per le foto.
- `supabase/seed.sql`: email del team e i tre design di partenza.
- `img/`: foto dei design iniziali. Quelle nuove si caricano dall'app e finiscono su Supabase Storage.

## Sezioni dell'app
- **Magazzino**: giacenze per taglia, in sola lettura: cambiano solo con vendite e merce arrivata. L'ingranaggio in alto a destra apre le Impostazioni: prezzo di vendita e costo dal fornitore standard (di partenza 20 € e 7,50 €) e il pulsante per la modalità Modifica (correzioni manuali con + e −, gestione dei modelli). Un singolo modello può avere un prezzo o un costo diverso dallo standard: si imposta in modalità Modifica.
- **Vendite**: ordini dei clienti (nome, modello, taglia, quantità, pagamento). Ogni vendita scala il magazzino; eliminarla rimette i pezzi. Prezzo e costo restano quelli del giorno della vendita; il prezzo viene proposto in base al modello.
- **Fornitore**: ordini che fate al fornitore, con pezzi per taglia. Con «Arrivato» i pezzi entrano in magazzino (una sola volta).
- **Guadagni**: incassato, costo dei pezzi venduti, guadagno e margine, spesa al fornitore, valore del magazzino. Filtro *Sempre* / *Questo mese*, dettaglio per modello e per metodo di pagamento.

Se avevi già eseguito `schema.sql` su Supabase, rieseguilo: aggiunge le nuove tabelle e il costo ai design senza toccare i dati.

## Messa online

### 1. GitHub
1. Crea l'organizzazione (o l'utente) **venetocore** su GitHub.
2. Crea un repository pubblico chiamato esattamente **venetocore.github.io**.
3. Carica tutti questi file nella radice del repository (anche `.nojekyll`).
4. Settings → Pages → Source: *Deploy from a branch*, branch `main`, cartella `/ (root)`.
5. Dopo un paio di minuti il sito è su https://venetocore.github.io

### 2. Supabase
1. Crea un progetto su https://supabase.com (regione EU, ad esempio Frankfurt).
2. SQL Editor → incolla `supabase/schema.sql` → Run.
3. Authentication → Users → *Add user* → *Create new user* per ogni persona del team: email, password e spunta *Auto Confirm User*. Un utente a testa, così i movimenti riportano chi li ha fatti.
4. In `supabase/seed.sql` metti le stesse email, poi eseguilo nel SQL Editor.
5. Authentication → Sign In / Providers → Email: disattiva *Allow new users to sign up*.
6. Project Settings → API: copia *Project URL* e *anon public key* in `config.js` e fai commit.

### Accesso
Si entra con email e password dell'utente creato in Supabase. Solo le email presenti nella tabella `team` vedono e modificano i dati. Le password si cambiano da Authentication → Users. Non scrivere le password nel repository, che è pubblico.

## Da sapere
- La anon key è fatta per stare nel codice pubblico: la protezione la fanno le regole RLS. Non mettere mai la *service_role key* nel repository.
- Sul piano gratuito Supabase mette in pausa i progetti senza attività per una settimana: basta riattivarlo dalla dashboard.
- Per aggiungere qualcuno al team: crealo in Authentication → Users e aggiungi la sua email alla tabella `team`.
"# venetocore.github.io" 
