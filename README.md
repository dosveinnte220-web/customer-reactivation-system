# customer-reactivation-system
A SaaS platform for customer reactivation and retention management
Testing the app locally
1. Start the server

In the project folder (VS Code integrated terminal):

bash
npm start

You should see CRS multi-negocio en http://localhost:3000. Open http://localhost:3000. Don't open index.html directly or through Live Server, because without the server there is no login and the app falls back to local demo mode.

2. Create an account

On the login screen, enter any email, a password of 8+ characters and a business name, then click Crear cuenta. The account starts empty.

3. Import a test database

Save this as clientes.csv:

csv
nombre,telefono,email,ultima_visita,ultima_compra,servicio,consentimiento
Carlos Mendoza,5512340001,carlos@mail.com,10/05/2026,10/05/2026,Membresía mensual,si
Ana Torres,5512340002,ana@mail.com,15/02/2026,15/02/2026,Clase de spinning,si
Luis Ramírez,5512340003,luis@mail.com,20/09/2026,20/09/2026,Entrenamiento personal,si
Sofía Herrera,5512340004,sofia@mail.com,01/01/2026,01/01/2026,Nutrición,no
Paula Ríos,5512340005,paula@mail.com,12/03/2026,12/03/2026,Clase de spinning,si

Go to Clientes → Importar base, pick the file, and check that the columns were matched correctly. Leave the date format on DD/MM/AAAA and click Importar.

Expected result: the app jumps to Inactivos and shows 4 inactive clients. Luis stays active because his last visit was recent. Sofía is inactive but marked "Sin consentimiento", so she is not eligible.

4. Run a campaign
In Campañas, open + Nueva campaña, click ✨ Generar mensaje con IA and create it.
Click Enviar lote de hoy. Expected: 3 messages sent, to Carlos, Ana and Paula, and never to Sofía.
5. Test the conversation flow

In Conversaciones, open Carlos and use the yellow demo bar to answer as the client:

Type sí, me interesa. The status changes to Interesado and a notice appears in the Dashboard.
Type mañana 10am. The status changes to Cita agendada.
Click 💰 Registrar venta and enter an amount. The status changes to Reactivado, and the Dashboard funnel and revenue update.
Open Ana and type baja. She is marked No interesado and loses consent.
6. Test the WhatsApp webhook (optional)

With only one account on this server, simulate an incoming WhatsApp message from Paula:

bash
curl -X POST localhost:3000/webhook -H 'Content-Type: application/json' \
 -d '{"entry":[{"changes":[{"value":{"messages":[{"from":"525512340005","text":{"body":"sí, cuánto cuesta?"}}]}}]}]}'

Within about 4 seconds, Paula's conversation should show the incoming message and the automatic reply.

7. Other checks worth running
Data isolation: log out with ↩ Salir, create a second account and confirm it starts empty.
Re-import: import the same CSV again with "Actualizar existentes". It should report 0 new and 5 updated, and Ana should stay without consent.
Persistence: stop the server with Ctrl + C, run npm start again and log in. Your data should still be there.
Reset everything

Stop the server and delete the data/ folder. All accounts and clients are removed.

Common problems
No login screen: you're not on http://localhost:3000, or the server isn't running.
.xlsx won't import: reading Excel files needs internet, so export to CSV or connect.
EADDRINUSE: port 3000 is busy. Set PORT=3001 in a .env file.
Webhook ignored: with two or more accounts, the test message must include "metadata":{"phone_number_id":"..."} matching the Phone Number ID saved under Configurar WhatsApp.
