# Play Live

Seus espectadores da **live do YouTube** jogam no **seu PC ou Xbox** pelo navegador.
Você escolhe quem joga; a pessoa escolhida recebe o botão **Jogar agora** na própria página da live, sem sair dela. Sem pagamento, sem cadastro, sem instalação para quem joga.

> Projeto independente. Não depende de nenhum outro repositório e não tem pagamento, fila paga nem pedidos.

## Como funciona

```
YouTube live --vídeo--> página inicial (/) <--apelido-- Espectadores
                             │ fila + chat
                             ▼
                    Servidor Play Live <── você, no /admin
                          │                   escolhe quem joga
                          │ (sinalização WebRTC, relógio, sessão)
              ┌───────────┴───────────┐
              ▼                       ▼
        Jogador (/play) <── vídeo WebRTC (P2P) ── PC do jogo (/host)
        controle no navegador ── comandos: DataChannel P2P ──> /host ──> ponte ──> controle virtual
                              (reserva: WebSocket via servidor ──────────> ponte)
```

- **Página inicial (`/`)**: mostra a live, a fila e o chat próprio. Só quem entrou na fila pode ler e enviar mensagens; o apelido da fila identifica a pessoa.
- **Painel (`/admin`)**: você cola o link da live, abre a sala, define os minutos e clica em **escolher**. **STOP** remove o player do PlayLive e limpa fila/chat, mas não encerra a live do YouTube nem uma sessão de jogo ativa.
- **Jogador (`/play`)**: recebe o vídeo do jogo em tempo real e envia comandos por controle físico (Gamepad API) ou pelos controles de toque em celulares e tablets.
- **Host (`/host`)**: roda no PC do jogo; captura a placa de captura (Xbox) ou uma janela (jogo de PC) e transmite por WebRTC.
- **Ponte de controle** (`tools/gamepad-bridge`): no Windows, transforma os comandos do jogador em um controle Xbox 360 virtual, para jogos de PC.
- O vídeo vai **direto** do host para o jogador (P2P); o servidor cuida da sinalização e mantém a fila e o chat temporário.

## Requisitos

| Parte | Precisa de |
|---|---|
| Servidor | Node.js 22+ (ou Docker). Sem dependências npm. |
| PC do jogo (host) | Navegador Chrome/Edge atualizado, internet estável com bom upload (4 a 8 Mbps por jogador). |
| Jogar jogos de PC | Windows 10/11, Python 3 e o driver **ViGEmBus** (para a ponte de controle). |
| Jogar Xbox físico | Placa de captura HDMI reconhecida como câmera (UVC) **e** uma forma de controlar o console (veja [Limites](#limites-e-avisos)). |
| Quem joga | Chrome/Edge no PC ou navegador moderno no celular/tablet; controle USB/Bluetooth ou controles de toque na tela. |
| Sua live | Uma live no YouTube e, de preferência, incorporação permitida. O chat do YouTube não é necessário. |

## Início rápido (teste local)

```bash
cp .env.example .env        # opcional
npm start                   # ou start.bat no Windows
```

O terminal mostra a **senha do painel** e a **chave do host** (se você não as definiu).

1. Abra `http://localhost:8080/admin`, entre com a senha.
2. Em **Live do YouTube**, cole o link da sua live, marque **Abrir sala para jogar** e salve.
3. Abra `http://localhost:8080/` em outra aba, digite um apelido e entre na sala.
4. Para testar sem PC conectado, defina `REQUIRE_ONLINE=0` no `.env` (senão o painel recusa escolher alguém com o PC do jogo offline).
5. No painel, clique em **escolher** ao lado do apelido. Na outra aba aparece **Jogar agora**.

## Rodando uma live (passo a passo)

1. **Ligue o PC do jogo** e abra `https://SEU-DOMINIO/host`. Informe a chave do host. Escolha a fonte:
   - *Placa de captura (Xbox)*: selecione a placa e o áudio, clique em **Iniciar captura da placa**.
   - *Janela do PC*: abra o jogo, clique em **Escolher janela do jogo** e marque **compartilhar áudio**. Esse clique é manual (o navegador não deixa automatizar) e a janela precisa ficar visível.
2. **(Jogos de PC)** inicie a ponte de controle no mesmo PC: `start-bridge.bat`. O painel passa a mostrar *Ponte de controle: online*.
3. **Comece a live** no YouTube (OBS) como sempre.
4. No `/admin`, cole o link da live, marque **Abrir sala para jogar** e salve. Divulgue `https://SEU-DOMINIO/` no chat e na descrição.
5. Os espectadores entram na sala com um apelido. Defina os **minutos** e clique em **escolher**. A pessoa vê **Jogar agora** e entra no `/play`.
6. O **relógio só começa** quando a imagem do jogo aparece para o jogador. Você pode **somar minutos** (+5, +10) ou **encerrar** a qualquer momento.
7. Ao acabar o tempo, a sessão encerra sozinha e a vaga fica livre para o próximo.

### Voz dos jogadores no OBS

- No `/play`, o jogador toca em **Ligar microfone** e autoriza o acesso quando o navegador pedir. O botão também desliga e libera o microfone.
- Com dois jogadores na mesma sessão (`MULTIPLAYER=1`), a voz de cada um é encaminhada pelo host diretamente ao outro jogador. A mídia não passa pelo servidor.
- O host reproduz a voz recebida na saída de áudio padrão do PC. Para incluí-la na live, configure o OBS para capturar essa saída com **Áudio do desktop/Captura de saída de áudio** ou capture o aplicativo Chrome/Edge que está aberto em `/host`.
- Se o navegador bloquear a reprodução automática no `/host`, clique em **Ativar reprodução de voz**. Use fones para reduzir eco e confirme o medidor do OBS antes de entrar ao vivo.

Regras que o sistema aplica:

- Só **uma pessoa joga por vez**.
- Só é possível escolher com o **host online** (e a **ponte online**, se `REQUIRE_BRIDGE=1`) e o jogo livre.
- Depois de escolhido, o jogador tem **30 segundos para abrir `/play`**. Se não entrar, o próximo da fila é escolhido automaticamente com os mesmos minutos; se a sala tiver dois jogadores, o lugar que vagou é preenchido sem interromper quem já entrou.
- Se o jogador entrar, mas a imagem não subir em `PROVISION_TIMEOUT_SEC` (180 s), a sessão é cancelada sem consumir tempo.
- Se as notificações deste site estiverem autorizadas no navegador, a página da live avisa quando chegar sua vez, inclusive em segundo plano.
- Avisos de 5 min e 1 min antes do fim.
- O jogador pode **desistir** quando quiser.

## Placa de captura e OBS ao mesmo tempo

Uma placa de captura só atende **um programa por vez**. Se o OBS (que transmite a live) já usa a placa, o `/host` não consegue abri-la. Soluções:

- Use a **câmera virtual do OBS** como fonte no `/host` (selecione-a na lista de câmeras), ou
- use um **splitter HDMI** com duas placas, ou
- no caso de jogo de PC, use **captura de janela** no host e uma captura separada no OBS.

## Configuração (variáveis de ambiente)

| Variável | Padrão | Para que serve |
|---|---|---|
| `PORT` | `8080` | Porta HTTP. |
| `BASE_URL` | `http://localhost:PORT` | URL pública (links de jogo). Em produção use `https://...`. |
| `DATA_DIR` | `./data` | Estado, configuração da live e segredos. |
| `DOMAIN` | — | Domínio público usado pelo Docker Compose com Caddy (sem `https://`). |
| `HOST_KEY` | gerada | Chave do host e da ponte. Vazia = gerada e guardada em `data/host-key.txt`. |
| `ADMIN_PASSWORD` | gerada | Senha do `/admin`. Vazia = gerada e guardada em `data/admin-password.txt`. |
| `MAX_MINUTES` | `60` | Máximo de minutos por pessoa. |
| `DEFAULT_MINUTES` | `10` | Valor sugerido no painel. |
| `PROVISION_TIMEOUT_SEC` | `180` | Prazo, após o jogador entrar, para a imagem subir antes de cancelar. Use `300` com captura de janela. |
| `REQUIRE_ONLINE` | `1` | `0` desliga a trava de PC offline (desenvolvimento). |
| `REQUIRE_BRIDGE` | `1` | `0` exige só o host (ex.: Xbox com placa de captura, sem ponte). |
| `MULTIPLAYER` | `0` | `1` permite até dois jogadores remotos na mesma sessão e partida. O segundo entra no tempo restante, sem reiniciar o relógio. |
| `MAX_REMOTE_PLAYERS` | `2` | Máximo de jogadores remotos simultâneos (1 ou 2; só vale com `MULTIPLAYER=1`). |
| `STUN_URL` | Google STUN | Servidor STUN. |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | vazios | TURN para jogadores atrás de CGNAT/firewall rígido. |
| `XBOX_POWER_ON_CMD`, `XBOX_POWER_OFF_CMD` | vazios | Comandos opcionais de ligar/desligar o Xbox (executados no servidor). |
| `TRUST_PROXY` | `0` | `1` atrás de Caddy/Nginx/Cloudflare/Coolify. |
| `DEBUG` | `0` | Log detalhado. |
| `BRIDGE_URL` | `ws://localhost:PORT/ws` | URL WebSocket do servidor para a ponte de controle. |
| `BRIDGE_PYTHON` | automático | Executável Python usado pela ponte (`python` no Windows, `python3` nos demais). |
| `BRIDGE_DRY_RUN` | `0` | `1` testa a ponte sem criar um controle virtual. |
| `BRIDGE_LOCAL_PORT` | `8765` | Porta do canal local entre o `/host` e a ponte (só `127.0.0.1`). `0` desliga os comandos por P2P. |
| `BRIDGE_ALLOWED_ORIGINS` | derivada | Origens extras aceitas no canal local, separadas por vírgula. Por padrão só o site de `BRIDGE_URL`. |

Copie `.env.example` para `.env` e ajuste as opções necessárias. Para a ponte em um PC separado, use `BRIDGE_URL` (ex.: `wss://SEU-DOMINIO/ws`) e a mesma `HOST_KEY` do servidor. Não versione `.env` nem a pasta `data/`.

## Ponte de controle (Windows)

```
Preferido (P2P):  navegador (/play) ──DataChannel──> /host ──ws://127.0.0.1──> ponte ──> controle Xbox 360 virtual ──> jogo
Reserva:          navegador (/play) ──WebSocket──> servidor ──────────────────> ponte
```

### Comandos por WebRTC (como o Xbox Cloud Gaming) e reserva por WebSocket

- O host abre um **DataChannel** `input` com o jogador, configurado como **não ordenado e sem reenvio** (comportamento de UDP): um estado antigo de botão não vale a pena ser reenviado. Os pacotes têm número de sequência, e o host descarta os que chegam fora de ordem.
- O estado do controle é reenviado a cada 100 ms e, a cada mudança, duas cópias extras seguem em 30 ms e 70 ms. Assim um pacote perdido (principalmente o de *soltar o botão*) é coberto.
- O host repassa os comandos para a ponte por um canal local (`ws://127.0.0.1:8765/local`). Por isso **o `/host` e a ponte precisam estar no mesmo PC**. O `/host` mostra *ponte local: online* quando a ligação existe.
- O **servidor continua mandando na sessão**: a ponte só aplica comandos enquanto o servidor informa sessão **ativa**, mesmo quando eles chegam pelo canal local. Ao terminar o tempo, ao fechar o canal ou ao perder o host, todos os botões são soltos.
- **Reserva automática:** o player testa os dois caminhos a cada segundo. Se o P2P cair, não responder por 3 s ou a ponte local não estiver conectada, os comandos voltam sozinhos para o WebSocket e retornam ao P2P quando ele se recuperar.
- **Segurança do canal local:** só escuta em `127.0.0.1`; recusa conexões de qualquer site que não seja o seu (confere `Origin`) e pedidos com `Host` estranho (DNS rebinding); exige a chave do host na primeira mensagem.
- O servidor também limita a 240 comandos por segundo por conexão no caminho WebSocket.
- Observação: páginas HTTPS conectando em `ws://127.0.0.1` são permitidas pelos navegadores baseados em Chromium, mas versões recentes do Chrome podem pedir uma **permissão de acesso à rede local** na primeira vez no `/host`: permita. Safari não é suportado no `/host`.

### Medindo a diferença entre P2P e WebSocket

No `/play`, abra **stats**. As linhas *comandos P2P* e *comandos WS* mostram o tempo de ida e volta até a ponte, em cada caminho (último valor, mediana e número de amostras), e *comandos via* indica qual caminho está em uso.

- Para comparar, jogue um tempo normalmente e depois abra o player com `?input=ws` (força o WebSocket) para ver o outro caminho em uso real.
- A sonda mede o trajeto jogador → ponte → jogador de cada caminho (inclui o servidor no WebSocket e o `/host` no P2P). Ela **não** mede o atraso do vídeo nem do jogo.

1. No PC do jogo, instale **Node 22+** e **Python 3** (marque *Add python.exe to PATH*).
2. Instale o driver **ViGEmBus** ([releases](https://github.com/nefarius/ViGEmBus/releases)) e reinicie o Windows se pedir. O `start-bridge.bat` instala só a biblioteca Python `vgamepad`; o driver precisa estar instalado antes.
3. Se o servidor está em outra máquina/VPS, crie um `.env` na pasta do projeto **no PC do jogo**:

   ```env
   BRIDGE_URL=wss://SEU-DOMINIO/ws
   HOST_KEY=<a mesma chave do servidor>
   ```

   O `.env` não vai para o Git. Nunca coloque a chave em arquivo versionado.
4. Rode `start-bridge.bat` (ou `npm run bridge`). **Inicie o jogo depois da ponte**.
5. O `/admin` mostra *Ponte de controle: online*.

Detalhes: os comandos só valem **durante a sessão ativa**; ao encerrar, perder conexão ou ficar 3 s sem sinal, todos os botões são soltos. Para testar sem driver (ou fora do Windows): `npm run bridge:dry`. O layout esperado é o *standard* do navegador (Xbox, PS4/PS5 e a maioria dos controles no Chrome/Edge).

## Hospedagem

### Docker Compose (servidor + HTTPS automático)

```bash
cp .env.example .env
# edite: DOMAIN=live.seudominio.com, ADMIN_PASSWORD, HOST_KEY
docker compose --profile caddy up -d --build
docker compose logs -f app      # mostra a senha do painel e a chave do host, se você não definiu
```

- O domínio precisa apontar para a VPS, com as portas **80** e **443** liberadas (o Caddy emite o certificado).
- `BASE_URL` e `TRUST_PROXY` são definidos pelo compose; o estado fica no volume `app-data`.
- O **PC do jogo continua no Windows**: abre `https://SEU-DOMINIO/host` no navegador e roda a ponte com `BRIDGE_URL=wss://SEU-DOMINIO/ws`.
- Atualizar: `git pull && docker compose up -d --build`.

Com TURN (jogadores atrás de CGNAT):

```bash
# no .env: TURN_URL=turn:SEU-DOMINIO:3478, TURN_USERNAME=..., TURN_CREDENTIAL=...
docker compose --profile caddy --profile turn up -d --build
```

Libere também `3478/tcp`, `3478/udp` e `49160–49200/udp` no firewall.

### Coolify

`docker-compose.coolify.yml` sobe só o servidor; domínio, HTTPS e WebSocket ficam com o proxy do Coolify.
O `docker-compose.yml` principal também funciona no Coolify sem ativar o perfil `caddy`; nesse caso, o domínio é roteado pelo proxy do Coolify.

1. **New Resource → repositório** → **Build Pack: Docker Compose** → **Docker Compose Location: `/docker-compose.coolify.yml`**.
2. Configure o **domínio** do serviço `app` (porta interna `8080`) e aponte o DNS para a VPS.
3. Em **Environment Variables**, defina **`BASE_URL`** com a URL pública `https://...` (obrigatória) e, se quiser, `ADMIN_PASSWORD`, `HOST_KEY`, `MAX_MINUTES` etc. Vazio = o servidor gera e guarda os segredos no volume.
4. Faça o deploy e veja os **Logs** para a senha do painel e a chave do host, se geradas.
5. Mantenha o volume `app-data` (ele guarda o estado e os segredos).

Sem Docker: `node --env-file-if-exists=.env src/server.js` atrás de um proxy com HTTPS e upgrade de WebSocket em `/ws` (Caddy: `reverse_proxy 127.0.0.1:8080`).

## Segurança

- O painel exige senha (cookie assinado, `HttpOnly`, 12 h) com limite de tentativas.
- O link de jogo (`/play.html?s=...`) é o **segredo da sessão**: só quem foi escolhido o recebe e ele deixa de valer quando a sessão acaba.
- A chave do host nunca vai para o navegador do espectador.
- O **apelido não é verificado**: qualquer pessoa pode usar o nome de outra. Não há login nem checagem de inscrito. Quem quiser isso precisa adicionar login com Google/YouTube.
- Use sempre **HTTPS** em produção (a Gamepad API, WebRTC e cookies seguros dependem disso).

## Limites e avisos

- **Xbox físico:** a ponte cobre jogos **no PC** (controle virtual via ViGEmBus). O console não aceita controle virtual: é preciso um adaptador de hardware ou transmitir o jogo para o PC (app do Xbox) e jogar por lá.
- **Atraso:** a live no YouTube tem atraso de segundos; **quem joga vê o vídeo pelo `/play` (WebRTC)**, não pela live. Espere cerca de 80 a 150 ms de ponta a ponta.
- **Escala:** a sala (apelidos) fica na memória do servidor; ao reiniciar, os espectadores precisam entrar de novo (quem está jogando continua). Limite de 200 pessoas na sala.
- **Chat próprio:** funciona enquanto a sala da live estiver aberta; só participantes da fila podem ler ou enviar mensagens. As últimas 100 mensagens ficam temporariamente na memória e são apagadas ao fechar/trocar a live ou reiniciar o servidor. No `/admin`, o host pode pausar o envio ou limpar o chat.
- **Celular/tablet:** o chat próprio funciona na página, sem redirecionar para o YouTube.
- **Direitos e termos:** dar acesso ao jogo a espectadores pode ferir os termos das plataformas e das desenvolvedoras. Confira antes de usar.
- **Testado:** servidor, sala, escolha, sessão, relógio, ponte (com sink simulado) e arquivos compose (sintaxe). **Não testado:** Windows com ViGEmBus, imagem Docker construída, Coolify, YouTube real e placa de captura real.

## Solução de problemas

| Sintoma | O que verificar |
|---|---|
| Painel recusa escolher: "computador do jogo offline" | `/host` aberto e conectado com a chave certa; ponte rodando (ou `REQUIRE_BRIDGE=0`). |
| Jogador fica em "preparando" e a sessão cancela | Clique em **Iniciar captura** no `/host` (captura de janela exige clique); aumente `PROVISION_TIMEOUT_SEC`. |
| Sem vídeo para o jogador | Configure TURN (`TURN_URL`, usuário, senha); confira portas do TURN. |
| Jogo não reconhece o controle | Inicie a ponte **antes** do jogo; confira o ViGEmBus; teste com `npm run bridge:dry`. |
| Comandos sempre por "WebSocket (reserva)" | `/host` mostra *ponte local: offline*? Rode a ponte no **mesmo PC** do `/host`, confira `BRIDGE_LOCAL_PORT` e se o navegador liberou o acesso à rede local. Sem TURN, o P2P também pode falhar atrás de CGNAT. |
| Não consigo participar do chat | Entre na fila da página inicial; se o chat estiver pausado, peça ao host para reabri-lo no `/admin`. |
| O player do YouTube não aparece | Confira se a live está aberta e se a incorporação está permitida. |
| `/host` não lista a placa | A placa precisa ser UVC; outro programa (OBS) pode estar usando-a. |

## Testes

```bash
npm test
```

Cobrem: sala e escolha de jogadores, chat restrito à fila e moderação, trava de PC offline, relógio e avisos, cancelamento por falta de imagem, e a ponte de controle ponta a ponta com um controle simulado.

## Estrutura

```
src/            servidor (HTTP, WebSocket, sessão, live)
public/         páginas: index (live), play, host, admin
tools/gamepad-bridge/   ponte de controle (Node + Python/vgamepad)
test/           testes (node --test)
Dockerfile, docker-compose.yml, docker-compose.coolify.yml, Caddyfile
```
