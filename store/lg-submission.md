# XSol Player: material para o LG Seller Lounge

Preparado para o passo 3 do envio ("Preencher os dados e enviar para aprovação").
Tudo aqui foi gerado a partir do projeto; o que **depende de você** está marcado com
**[VOCÊ]**. Os textos para colar nos formulários estão em inglês, porque é o idioma do
Seller Lounge.

## 1. O que está pronto

| Item pedido pela LG | Requisito | Arquivo | Estado |
| --- | --- | --- | --- |
| Pacote | `.ipk`, versão, App ID | `com.xsol.player_1.0.0_all.ipk` (gerado por `./build.sh`) | pronto; App ID `com.xsol.player`, versão `1.0.0` |
| Ícone | 400 x 400 px ou maior, até 5 MB | `store/icon-512.png` (512 x 512) e `store/icon-400.png` | pronto |
| Capturas de tela | 960 x 540 ou 1280 x 720, até 5 MB cada | `store/screenshots/*-1280x720.png` e `*-960x540.png` (7 telas) | pronto |
| Imagem de fundo | 1920 x 1080, até 10 MB | `store/background-1920x1080.png` | pronto |
| Países, classificação etária | formulário | seção 3 | **[VOCÊ]** escolher |
| Política de privacidade | URL pública | texto na seção 4 | **[VOCÊ]** publicar e informar a URL |
| Self-Checklist | planilha da LG, PASS / FAIL / N/A | rascunho na seção 6 | **[VOCÊ]** preencher a planilha oficial |
| UX Scenario | roteiro para os testadores | seção 5 | pronto |
| Conta de teste | se o app exigir login | seção 7 | **[VOCÊ]** fornecer |

As capturas mostram dados sintéticos (canais "News 1", "Sports 1", filmes inventados):
nenhum nome, logo ou marca de terceiros.

## 2. Dados do app (copiar para o formulário)

- **App ID:** `com.xsol.player` (permanente e preso à conta; confirme que a conta do
  Seller Lounge está no nome do dono real do app).
- **Title:** XSol Player
- **Version:** 1.0.0
- **Vendor:** XSol
- **Resolução:** 1920 x 1080 (`appinfo.json`). **Alvo mínimo:** webOS 4.
- **Idiomas da interface:** inglês e português do Brasil. O título e a descrição do
  app existem também em de, es, fr, it, ru, uk e zh-Hans-CN (`resources/`), mas a
  interface em si só tem en e pt-BR; declare só esses dois como idiomas do app.

**Short description (EN)**

> Media player for your own M3U and Xtream playlists, with a program guide, catch-up,
> movies and series.

**Full description (EN)**

> XSol Player plays the playlists you already have. Add your M3U or Xtream Codes
> account and browse live channels, the program guide (XMLTV), catch-up, movies and
> series from one remote-friendly screen.
>
> - Live channels grouped and searchable, with favorites, recently watched and a live
>   preview.
> - Program guide with day navigation, catch-up playback and reminders.
> - Movies and series with posters, details, continue watching and a watchlist.
> - Subtitles and audio track selection, including online subtitle search with your own
>   provider keys.
> - Parental control with a PIN, and the option to hide categories.
> - Colour-key shortcuts and Magic Remote support.
>
> XSol Player does not include or sell any channels or content. You provide your own
> playlist or account.

**Descrição curta (PT-BR)**

> Player para as suas listas M3U e Xtream, com guia de programação, reprises, filmes e
> séries.

**Descrição completa (PT-BR)**

> O XSol Player reproduz as listas que você já tem. Adicione sua conta M3U ou Xtream
> Codes e navegue por canais ao vivo, guia de programação (XMLTV), reprises, filmes e
> séries em uma tela pensada para o controle remoto.
>
> - Canais ao vivo agrupados e com busca, favoritos, assistidos recentemente e
>   pré-visualização ao vivo.
> - Guia de programação com navegação por dia, reprises e lembretes.
> - Filmes e séries com pôsteres, detalhes, continuar assistindo e lista de favoritos.
> - Legendas e escolha de faixa de áudio, inclusive busca online de legendas com as suas
>   próprias chaves.
> - Controle parental com PIN e opção de ocultar categorias.
> - Atalhos pelas teclas coloridas e suporte ao Magic Remote.
>
> O XSol Player não inclui nem vende canais ou conteúdo. Você informa a sua própria
> lista ou conta.

Observação: evitei a palavra "IPTV" nos textos novos, em linha com a descrição curta
que você deixou no `appinfo.json` ("Player with M3U, Xtream, XMLTV, and catch-up.").
Os `resources/*/appinfo.json` ainda dizem "IPTV"; vale alinhar antes do envio, para o
título e a descrição não divergirem entre idiomas.

## 3. Países e classificação etária **[VOCÊ]**

- **Países:** a escolha é sua. O app tem interface em inglês e português; faz sentido
  começar por Brasil e países de língua inglesa em que você pode dar suporte.
- **Classificação etária:** o app **não traz conteúdo próprio**; o que aparece depende da
  lista de cada usuário, que pode incluir conteúdo adulto. O app tem controle parental
  (PIN e ocultar categorias). Eu não sei qual classificação a LG vai aceitar para um
  player de listas do usuário, então responda ao questionário de classificação do
  Seller Lounge com isso em mente e confira as diretrizes atuais deles; a menos
  restritiva que declara que o conteúdo é de terceiros costuma ser a mais honesta.

## 4. Política de privacidade (texto-base) **[VOCÊ]**

A LG exige uma **URL pública** da política. O painel do XSol já tem campos
`privacy_policy_*`; se a política ficar no portal, use essa URL. O texto abaixo
descreve o que o app faz **de fato** (conferido no código); complete os trechos entre
colchetes e revise com quem responde juridicamente pelo serviço.

> **XSol Player: Privacy Policy**
>
> *Last updated: [DATE]*
>
> **Who we are.** XSol Player is operated by [COMPANY OR PERSON NAME]. Contact:
> [SUPPORT EMAIL].
>
> **What the app does.** XSol Player plays playlists, program guides and catalogs that
> you provide. We do not provide, host or control any channel or media content.
>
> **Data stored on your TV.** Your playlist and account addresses, credentials, favorites,
> watch history, resume positions, reminders and settings are stored on the device only.
> You can erase them in Settings > Data Management, or by uninstalling the app.
>
> **Data sent to our activation service.** To activate the app, the TV sends to our
> activation server: a device identifier derived from the TV's network (MAC) address, a
> device name, the app version and the activation status. While the app is open it also
> sends, about once a minute, a presence signal that includes the type and title of what
> you are watching (channel, movie or episode). This is used to manage your activation
> and show your own activity in your account; [STATE RETENTION PERIOD AND WHO CAN SEE IT].
>
> **Your own providers.** The app connects directly to the playlist, Xtream or guide
> address you configure, and to artwork and stream addresses those services return.
> Those providers have their own policies. If you enable online subtitle search, the
> app sends search requests (the title and, if available, an identifier) to the subtitle
> provider you choose, using your own key; these providers are SubDL, Assrt and
> OpenSubtitles.
>
> **What we do not do.** The app has no advertising and no analytics or crash-reporting
> service, and we do not sell your data.
>
> **Your choices.** You can stop all data sharing by uninstalling the app. To ask about,
> correct or delete data held by the activation service, contact [SUPPORT EMAIL].
>
> **Children.** The app has a parental-control PIN and can hide categories, but the
> content shown comes from your own provider.
>
> **Changes.** We will post changes on this page.

Antes de publicar, confirme **duas coisas que eu não consegui verificar daqui**: (1) se o
painel guarda o histórico do que cada aparelho assiste ou só o estado atual, e por
quanto tempo; (2) se existe algum anúncio ou métrica no lado do servidor (o código do
app não tem nenhum).

## 5. UX Scenario (roteiro para os testadores da LG)

**Pré-requisito:** TV com internet. Os dados de teste da seção 7 em mãos.
**Teclas:** setas, OK e Back; o app também usa as teclas coloridas e o Magic Remote.

| # | Cenário | Passos | Resultado esperado |
| --- | --- | --- | --- |
| 1 | Primeira abertura | Abrir o app pela primeira vez | Tela de acesso com o código MAC e a chave de 6 dígitos do aparelho, e a forma de configurar o acesso |
| 2 | Configurar o acesso | Usar os dados da seção 7 (no portal ou digitando a conta na TV) | O app carrega os canais e abre a Home |
| 3 | Home | Navegar pelos cartões com as setas | Cartões Live TV, Movies, Series, Access e Settings; "Continue" retoma o último canal |
| 4 | TV ao vivo | Home > Live TV; escolher um grupo e um canal; OK | A lista abre; OK inicia a reprodução; Back volta à lista |
| 5 | Trocar de canal | Durante a reprodução, CH+/CH- ou seta cima/baixo | O canal muda; o número digitado no controle abre o canal correspondente |
| 6 | Guia | Tecla vermelha (ou seção TV) | Guia com canais, dias e programas; programa passado oferece reprise quando o provedor tem esse recurso; Back ou vermelho voltam |
| 7 | Filmes e séries | Abrir Movies ou Series | Capas, destaque e categorias; OK abre os detalhes; verde favorita, amarelo troca a ordem |
| 8 | Busca | Ícone da lupa; digitar | Resultados de canais, programas, filmes e séries |
| 9 | Configurações | Tecla azul ou Settings | Cartões de configuração; cada um abre a sua tela; Back volta |
| 10 | Controle parental | Settings > Parental control | PIN pedido ao ativar; categorias podem ser ocultadas |
| 11 | Sair | Back na tela inicial duas vezes | Mensagem "Press back again to exit", depois o app fecha |
| 12 | Sem rede | Desligar a rede e reabrir | Esperado, a confirmar na TV: o app abre com a lista em cache, sem travar, e avisa quando não consegue atualizar |

(Confira o cenário 12 você mesmo na TV antes do envio; veja a seção 6.)

## 6. Self-Checklist: rascunho de pré-verificação

O checklist **oficial** é a planilha que a LG fornece no Seller Lounge; eu não tenho o
modelo. Use esta tabela como ponto de partida e **confirme cada linha na TV**: só marquei
"provável" o que o código sustenta, e "verificar" o que só um teste real prova.

| Área | O que a LG costuma olhar | Evidência no projeto | Situação |
| --- | --- | --- | --- |
| Pacote | App ID, versão e título consistentes | `appinfo.json`: `com.xsol.player`, 1.0.0 | provável PASS |
| Resolução | Tela 1920 x 1080 | `"resolution": "1920x1080"` | provável PASS |
| Teclas | Setas, OK e Back funcionam em todas as telas | mapeamento em `key-handler.ts`, testes e2e | provável PASS; verificar na TV |
| Back na raiz | Back sai do app (com confirmação) | `confirmExit`: pede Back duas vezes | provável PASS; verificar |
| Magic Remote | Ponteiro, OK e roda funcionam | tratamento de clique e da roda | verificar na TV |
| Retomar | App volta do segundo plano sem travar | instalação exige reinício a frio; retomar | verificar na TV |
| Rede | Falha de rede tratada sem travar | `app.loadFailed`, cache da lista | verificar (cenário 12) |
| Desempenho | Abertura em tempo razoável | carrega do cache; sem cache baixa a lista | verificar numa lista grande |
| Idiomas | Texto correto nos idiomas declarados | en e pt-BR completos (catálogos com as mesmas chaves) | provável PASS |
| Conteúdo | O app não traz conteúdo de terceiros | só reproduz o que o usuário informa | PASS, se a conta de teste for conteúdo legal |
| Privacidade | Política pública | seção 4 | pendente de publicar |
| Anúncios, links externos | Sem anúncio nem navegador externo | o código não tem | provável PASS |

## 7. Conta de teste **[VOCÊ]**

O app **exige ativação**: ao abrir numa TV nova ele mostra o MAC e a chave, e só carrega
canais depois de configurar uma fonte. O revisor da LG vai abrir numa TV dele, então
precisa de uma forma de chegar a conteúdo **sem depender de você**:

- Uma conta **Xtream Codes** (servidor, usuário e senha) ou uma lista **M3U** de teste,
  que o revisor digita na própria TV (Settings > Sources), **válida durante todo o
  período de análise** (a LG pode levar semanas e testa mais de uma vez).
- O conteúdo da conta deve ser **legal e inofensivo** (canais abertos, conteúdo livre ou
  de demonstração, com pelo menos: canais ao vivo com guia, alguns filmes e séries).
  Uma conta com conteúdo pirata ou de procedência duvidosa é o motivo mais provável de
  reprovação num app deste tipo.
- Confirmar que o aparelho do revisor **entra em teste/ativado** sem passo manual seu.
  Hoje um aparelho novo é registrado como teste de [DIAS] dias; confira que isso cobre o
  período de análise, ou crie uma chave de ativação de longa duração para a LG.
- Informe no campo de notas do Seller Lounge: "The app requires a playlist. Use these
  test credentials: server [URL], user [USER], password [PASSWORD]."

Não incluí credenciais aqui de propósito: este arquivo vai para o repositório.

## 8. Como regenerar o material

Veja `store/README.md`.
