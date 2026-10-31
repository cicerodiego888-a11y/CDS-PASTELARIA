# Correção do seletor de empresas do ADMIN

Central de Entradas. O seletor do usuário Diego, com perfil ADMIN, mostrava somente “Todas as empresas” e “0 empresas ativas”.

Data: 31/10/2026.

Nenhuma alteração no Motor Fiscal, no Motor F×NF, na sincronização, nos schedulers, na manifestação ou nas configurações avançadas. Nenhum vínculo foi gravado. O banco oficial não foi aberto.

## Causa raiz

O seletor chama `GET /api/empresas/contexto/disponiveis`. Esse endpoint usa `EmpresaService.listarEmpresasDisponiveis`, que delega a `UsuarioEmpresaService.listarEmpresasPermitidas`.

A consulta só devolvia linhas de `usuario_empresas` com vínculo ativo e empresa ativa. Perfil e `role` não entravam. Sem linha para o usuário, a API respondia `[]` com sucesso.

`POST /api/empresas` grava o vínculo apenas para quem cadastrou a empresa (`req.user` no momento do cadastro). O SUPER ADMIN que criou as empresas ficou com essas linhas. Um ADMIN que não cadastrou a empresa ficou sem linha.

A seleção individual usa o mesmo critério em `exigirEmpresaAutorizada`. Sem vínculo, a empresa era recusada mesmo para o perfil ADMIN.

O login só trata `role === 'admin'` como administrador ao expandir permissões. O perfil `ADMIN` com `role` operador continuava administrador na hierarquia de `exigirAdmin`, e continuava invisível para o seletor.

## Comparação técnica

| Etapa | SUPER ADMIN | Diego com perfil ADMIN e `role` operador |
|---|---|---|
| Login | JWT com `id`, `role: admin`, `perfil: SUPER_ADMIN`. Permissões expandidas porque `role === 'admin'` | JWT com `id`, `role: operador`, `perfil: ADMIN`. A lista de permissões não é expandida. O perfil não é reescrito |
| `req.user` | `role` admin e perfil SUPER_ADMIN | `role` operador e perfil ADMIN |
| Reconhecimento de administrador | `exigirAdmin` aceita os dois | `exigirAdmin` aceita o perfil ADMIN. O seletor, antes da correção, ignorava esse reconhecimento |
| Listagem | `listarEmpresasPermitidas` lia só `usuario_empresas`. O cadastro da empresa já tinha criado o vínculo do autor | A mesma função, sem linha em `usuario_empresas`, devolvia `[]` |
| Tela | Opções das empresas vinculadas, mais “Todas as empresas” | Só “Todas as empresas” e o contador “0 empresas ativas” |

O cadastro vivo de Diego e do SUPER ADMIN não foi lido. A divergência acima é a do código: a lista dependia do vínculo do autor do cadastro, não do perfil ADMIN.

## Origem de “0 empresas ativas”

`carregarEmpresasPermitidasCentral` grava a resposta de `CdsEmpresaContexto.listarDisponiveis()` em `empresasPermitidas` e marca `empresasEstado = 'ok'`.

`renderAreaEmpresasCentral` conta `empresasParaAreaCentral()`. Com a lista vazia e o estado `ok`, o texto é `0 empresas ativas`. A opção “Todas as empresas” é fixa no modo MULTIEMPRESA. Lista vazia também força `vistaEmpresas = 'todas'` em `garantirEmpresaAtivaParaCentral`.

Estado `erro` mostraria “empresas indisponíveis”. O sintoma observado é lista autorizada vazia, não falha de API.

Em EMPRESA_SIMPLES o seletor não oferece “Todas as empresas”. O sintoma visto está no modo MULTIEMPRESA.

## Correção

`administradorOperacional` reconhece `role === 'admin'`, perfil `SUPER_ADMIN` ou perfil `ADMIN`. É a mesma faixa de `exigirAdmin`. Perfil ADMIN entra sem `role === 'admin'`.

Para esse sujeito:

- `listarEmpresasPermitidas` devolve as empresas ativas. Empresa inativa fica de fora.
- `usuarioPodeAcessarEmpresa` autoriza a empresa ativa, e a seleção individual passa.

Usuário comum continua limitado às linhas ativas de `usuario_empresas`. Usuário sem vínculo e sem esse perfil recebe lista vazia e `EMPRESA_NAO_AUTORIZADA` ao selecionar.

Nenhuma linha é inserida em `usuario_empresas`. O perfil e o `role` de Diego não são alterados. Configurações avançadas continuam exclusivas de `SUPER_ADMIN`.

“Todas as empresas” na Central segue `listarEmpresasPermitidas`. Para o ADMIN, o consolidado são as empresas ativas. Para o usuário comum, só os vínculos.

## Arquivos alterados

- `backend/services/empresas/UsuarioEmpresaService.js`
- `tests/central-entradas/cds-central-seletor-empresas-admin.test.js`
- `docs/central-entradas/CORRECAO-SELETOR-EMPRESAS-ADMIN-RELATORIO.md`

## Testes

`node --test --test-concurrency=1 tests/central-entradas/cds-central-seletor-empresas-admin.test.js`

Banco `:memory:`.

| Cenário | Resultado |
|---|---|
| SUPER ADMIN vê as empresas ativas, não vê a inativa, e seleciona uma empresa | Passou |
| ADMIN com `role` operador vê as mesmas ativas, sem vínculo gravado, troca da empresa A para a B, e a inativa responde `EMPRESA_INATIVA` | Passou |
| Usuário comum vê só o próprio vínculo e recebe `EMPRESA_NAO_AUTORIZADA` na outra empresa. Sem vínculo, a lista vem vazia | Passou |
| Consolidado do ADMIN reúne só as ativas. O do usuário comum não passa do vínculo | Passou |
| O texto “0 empresas ativas” sai do tamanho da lista autorizada. A tela não filtra opção por `role === 'admin'` | Passou |

5 passaram, 0 falharam.

## Pendências

O banco oficial não foi consultado. Se o usuário Diego estiver gravado com perfil diferente de `ADMIN` e `SUPER_ADMIN`, e com `role` diferente de `admin`, o seletor continua dependendo de `usuario_empresas`. Nesse caso o vínculo precisa ser conferido no cadastro. Esta correção não cria esse vínculo.

A expansão de permissões no login continua restrita a `role === 'admin'`. A Central já abria para o Diego, então essa diferença não alimentava o seletor. Configurações avançadas permanecem só com `SUPER_ADMIN`.
