# Play Live

Seus espectadores da **live do YouTube** jogam no **seu PC ou Xbox** pelo navegador.
Você escolhe quem joga; a pessoa escolhida recebe o botão **Jogar agora** na própria página da live, sem sair dela. Sem pagamento, sem cadastro, sem instalação para quem joga.

> Projeto independente. Não depende de nenhum outro repositório e não tem pagamento, fila paga nem pedidos.

## Como funciona

```
                     ┌──────────── YouTube (live + chat embutidos) ────────────┐
                     │                                                         │
Espectadores ──> página inicial (/) ──┐                                        │
  (apelido)                            ▼                                        │
                                  Servidor Play Live  <── você, no /admin: escolhe quem joga
                                       │  (sinalização WebRTC, relógio, sessão)
              ┌────────────────────────┴───────────────┐
              ▼                                        ▼
        Jogador (/play)  <── vídeo WebRTC (P2P) ──  PC do jogo (/host)
        controle no navegador ── WebSocket ──>  ponte de controle ──> controle virtual
```

- **Página inicial (`/`)**: mostra o player e o chat do YouTube e uma sala onde o espectador entra com um apelido.
- **Painel (`/admin`)**: você cola o link da live, abre a sala, define os minutos e clica em **escolher**.
- **Jogador (`/play`)**: recebe o vídeo do jogo em tempo real e envia o controle (Gamepad API do navegador).
- **Host (`/host`)**: roda no PC do jogo; captura a placa de captura (Xbox) ou uma janela (jogo de PC) e transmite por WebRTC.
- **Ponte de controle** (`tools/gamepad-bridge`): no Windows, transforma os comandos do jogador em um controle Xbox 360 virtual, para jogos de PC.
- O vídeo vai **direto** do host para o jogador (P2P); o servidor só faz a sinalização.

## Requisitos

| Parte | Precisa de |
|---|---|
| Servidor | Node.js 22+ (ou Docker). Sem dependências npm. |
| PC do jogo (host) | Navegador Chrome/Edge atualizado, internet estável com bom upload (4 a 8 Mbps por jogador). |
| Jogar jogos de PC | Windows 10/11, Python 3 e o driver **ViGEmBus** (para a ponte de controle). |
| Jogar Xbox físico | Placa de captura HDMI reconhecida como câmera (UVC) **e** uma forma de controlar o console (veja [Limites](#limites-e-avisos)). |
| Quem joga | Controle (USB ou Bluetooth) conectado ao aparelho; Chrome/Edge no PC ou Android. |
| Sua live | Uma live no YouTube **com chat ativado** e, de preferência, incorporação permitida. |

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

Regras que o sistema aplica:

- Só **uma pessoa joga por vez**.
- Só é possível escolher com o **host online** (e a **ponte online**, se `REQUIRE_BRIDGE=1`) e o jogo livre.
- Se a imagem não subir em `PROVISION_TIMEOUT_SEC` (180 s), a sessão é cancelada sem consumir tempo.
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
| `HOST_KEY` | gerada | Chave do host e da ponte. Vazia = gerada e guardada em `data/host-key.txt`. |
| `ADMIN_PASSWORD` | gerada | Senha do `/admin`. Vazia = gerada e guardada em `data/admin-password.txt`. |
| `MAX_MINUTES` | `60` | Máximo de minutos por pessoa. |
| `DEFAULT_MINUTES` | `10` | Valor sugerido no painel. |
| `PROVISION_TIMEOUT_SEC` | `180` | Prazo para a imagem subir antes de cancelar. Use `300` com captura de janela. |
| `REQUIRE_ONLINE` | `1` | `0` desliga a trava de PC offline (desenvolvimento). |
| `REQUIRE_BRIDGE` | `1` | `0` exige só o host (ex.: Xbox com placa de captura, sem ponte). |
| `STUN_URL` | Google STUN | Servidor STUN. |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | vazios | TURN para jogadores atrás de CGNAT/firewall rígido. |
| `XBOX_POWER_ON_CMD`, `XBOX_POWER_OFF_CMD` | vazios | Comandos opcionais de ligar/desligar o Xbox (executados no servidor). |
| `TRUST_PROXY` | `0` | `1` atrás de Caddy/Nginx/Cloudflare/Coolify. |
| `DEBUG` | `0` | Log detalhado. |

Para a ponte (no PC do jogo): `BRIDGE_URL` (ex.: `wss://SEU-DOMINIO/ws`), `BRIDGE_PYTHON`, `BRIDGE_DRY_RUN`. Veja `.env.example`.

## Ponte de controle (Windows)

```
Controle do jogador ──> navegador (/play) ──WebSocket──> servidor ──> ponte ──> controle Xbox 360 virtual ──> jogo
```

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
docker compose up -d --build
docker compose logs -f app      # mostra a senha do painel e a chave do host, se você não definiu
```

- O domínio precisa apontar para a VPS, com as portas **80** e **443** liberadas (o Caddy emite o certificado).
- `BASE_URL` e `TRUST_PROXY` são definidos pelo compose; o estado fica no volume `app-data`.
- O **PC do jogo continua no Windows**: abre `https://SEU-DOMINIO/host` no navegador e roda a ponte com `BRIDGE_URL=wss://SEU-DOMINIO/ws`.
- Atualizar: `git pull && docker compose up -d --build`.

Com TURN (jogadores atrás de CGNAT):

```bash
# no .env: TURN_URL=turn:SEU-DOMINIO:3478, TURN_USERNAME=..., TURN_CREDENTIAL=...
docker compose --profile turn up -d --build
```

Libere também `3478/tcp`, `3478/udp` e `49160–49200/udp` no firewall.

### Coolify

`docker-compose.coolify.yml` sobe só o servidor; domínio, HTTPS e WebSocket ficam com o proxy do Coolify.

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
- **Chat e player do YouTube** só carregam com a live ao vivo/programada, chat ativado e incorporação permitida.
- **Direitos e termos:** dar acesso ao jogo a espectadores pode ferir os termos das plataformas e das desenvolvedoras. Confira antes de usar.
- **Testado:** servidor, sala, escolha, sessão, relógio, ponte (com sink simulado) e arquivos compose (sintaxe). **Não testado:** Windows com ViGEmBus, imagem Docker construída, Coolify, YouTube real e placa de captura real.

## Solução de problemas

| Sintoma | O que verificar |
|---|---|
| Painel recusa escolher: "computador do jogo offline" | `/host` aberto e conectado com a chave certa; ponte rodando (ou `REQUIRE_BRIDGE=0`). |
| Jogador fica em "preparando" e a sessão cancela | Clique em **Iniciar captura** no `/host` (captura de janela exige clique); aumente `PROVISION_TIMEOUT_SEC`. |
| Sem vídeo para o jogador | Configure TURN (`TURN_URL`, usuário, senha); confira portas do TURN. |
| Jogo não reconhece o controle | Inicie a ponte **antes** do jogo; confira o ViGEmBus; teste com `npm run bridge:dry`. |
| O chat do YouTube não aparece | A live precisa estar no ar com chat ativado e incorporação permitida. |
| `/host` não lista a placa | A placa precisa ser UVC; outro programa (OBS) pode estar usando-a. |

## Testes

```bash
npm test
```

Cobrem: sala e escolha de jogadores, trava de PC offline, relógio e avisos, cancelamento por falta de imagem, e a ponte de controle ponta a ponta com um controle simulado.

## Estrutura

```
src/            servidor (HTTP, WebSocket, sessão, live)
public/         páginas: index (live), play, host, admin
tools/gamepad-bridge/   ponte de controle (Node + Python/vgamepad)
test/           testes (node --test)
Dockerfile, docker-compose.yml, docker-compose.coolify.yml, Caddyfile
```
