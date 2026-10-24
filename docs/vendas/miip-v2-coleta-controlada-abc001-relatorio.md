# MIIP V2 — Coleta controlada da ocorrência alvo

**Resultado:** `INCONCLUSIVO` — coleta da ocorrência real bloqueada por ausência de dados de teste autorizados e isolados.  
**Escopo executado:** conferência documental e inventário de nomes de arquivos; nenhum banco foi aberto, consultado ou alterado; nenhuma aplicação foi iniciada.

## 1. Instrumentação conferida

O relatório anterior de instrumentação foi revisado: [miip-v2-instrumentacao-origem-candidato-relatorio.md](./miip-v2-instrumentacao-origem-candidato-relatorio.md).

Os principais pontos que contêm hooks são:

- `backend/motores/miip/diagnostics/MiipOriginDiagnostics.js` — gate opt-in, correlação e eventos minimizados;
- `backend/motores/miip/repositories/ProdutoRepository.js` — hits/misses de cache MIIP e busca universal;
- `backend/motores/miip/services/MiipImportacaoXmlService.js` — contexto da operação;
- `backend/motores/central-entradas/services/CentralProcessamentoService.js` — resultado persistido reutilizado ou novo processamento;
- `backend/motores/produto-identidade/services/ProdutoIdentidadeCatalogo.js` — hits/misses de cache e consultas MIP;
- `frontend/erp/js/miip-central-revisao-inteligente.js` — evento `campos_identidade_ui`, condicionado ao flag global de navegador.

O backend só emite eventos quando, simultaneamente, `NODE_ENV=test`, `CDS_MIIP_ORIGIN_DIAGNOSTICS=1` e `DB_DIR` aponta para um subdiretório de `os.tmpdir()`. A interface requer `window.CDS_MIIP_ORIGIN_DIAGNOSTICS = true` no navegador de teste. Nenhum hook foi alterado ou duplicado nesta coleta.

### Inicialização segura

Não há nos scripts de `package.json` um comando dedicado que inicie o backend da aplicação em modo de teste sem bootstrap. `npm start:erp` inicia o Electron ERP; `backend/server.js` carrega `backend/database.js`, e esse módulo abre a conexão SQLite e inicia a inicialização do banco/schema. Portanto, não executei `npm start:erp`, `npm start` nem `node backend/server.js`: sem um harness autorizado que evite rotinas de inicialização/migração, isso não atende à restrição de não executar migrações ou rotinas que possam alterar dados.

O relatório anterior fornece as variáveis de ambiente, mas não define um entrypoint não mutável para executar a revisão completa. Para uma futura coleta, é necessário um harness de teste aprovado que use fixture autorizada e não inicialize/migre dados operacionais, ou uma autorização explícita para preparar uma cópia isolada e descartável com o schema necessário. Nenhuma dessas opções foi presumida aqui.

## 2. Verificação de disponibilidade e autorização

- O arquivo `backend\banco\mercadao.db` existe no workspace, mas sua procedência e autorização continuam não confirmadas. Foi apenas listado por nome/tamanho; **não foi aberto, copiado, consultado nem usado**.
- Há diretórios temporários com nomes associados a testes de NF-e/Central. Eles não foram inspecionados por dentro nem tratados como cópia autorizada da ocorrência.
- Não foi localizado, pelos nomes dos arquivos em `docs\vendas`, `tests\miip` e `tests\central-entradas`, um artefato identificado como cópia autorizada ou fixture da ocorrência.
- A página compartilhada aponta para uma instância ERP local; não foi aberta nem manipulada, pois não está identificada como navegador de teste autorizado.
- Nenhum log original `[MIIP_ORIGIN_DIAG]`, export do resultado persistido ou documento minimizado foi fornecido nesta interação.

Um nome de arquivo ou a presença de um SQLite no workspace não comprova autorização nem isolamento.

## 3. Coleta e correlação

Nenhum backend ou navegador de teste foi iniciado; logo, **não houve eventos da ocorrência para coletar**.

| Campo | Evidência disponível nesta coleta |
|---|---|
| `documentoId` / `operacaoId` | Não fornecidos |
| `produtoId` | Não fornecido |
| `origemResultado` | Não observada |
| Motor, score e evidências | Não observados |
| Hits/misses de cache e fonte da consulta | Não observados |
| Origem dos campos na interface | Não observada |
| Correlação por timestamp/IDs | Impossível sem eventos |

Não foram usados dados sintéticos para atribuir causa à ocorrência real. Nenhum evento foi fabricado ou inferido.

## 4. Classificação

**`INCONCLUSIVO`** — não há eventos da ocorrência nem fixture autorizada que permita reprodução. Não é possível escolher entre resultado persistido, cache obsoleto, associação de fornecedor, busca atual MUBC/similaridade ou fontes combinadas. Isso não constitui evidência a favor ou contra qualquer dessas hipóteses.

## 5. Dado mínimo necessário para prosseguir

Fornecer **uma fixture isolada e autorizada da ocorrência**, ou um export minimizado equivalente, contendo apenas:

1. O documento de teste e seus identificadores internos, com os campos mínimos do item necessários para repetir a identificação; não é necessário fornecer o XML completo.
2. O resultado MIIP persistido, se existente, incluindo estado de processamento, snapshot do candidato, score, motor, evidências e atributos de origem; preservar IDs internos necessários à correlação.
3. O registro de catálogo do `produtoId` candidato e somente as associações de fornecedor/produto relevantes para esse item.
4. Autorização explícita para usar essa fixture em diretório temporário isolado e indicação de um harness que não rode migrações nem acesse o banco operacional.

Alternativamente, um log `[MIIP_ORIGIN_DIAG]` e o evento `campos_identidade_ui` capturados durante uma reprodução já autorizada podem permitir a correlação sem disponibilizar o XML. Para comprovar um hit de cache, a coleta precisa ocorrer no processo em que o lookup acontece; um cache em memória de uma execução passada não pode ser reconstruído retroativamente apenas a partir do catálogo atual.

Não é necessário enviar banco oficial, XML completo, CNPJ, nome de fornecedor ou outros dados pessoais/fiscais. Não colar valores de identificação na conversa; disponibilizar a fixture por canal/local autorizado e informar apenas o caminho isolado e o escopo de autorização.

## 6. Confirmações

- `backend\banco\mercadao.db` e o banco oficial não foram abertos nem consultados.
- Nenhuma migração, identificação MIIP ou operação de revisão foi executada.
- Nenhuma operação SEFAZ foi realizada e nenhum HTTP 403 foi contornado.
- Nenhum cache foi limpo/inutilizado; candidatos, scores e regras não foram alterados.
- Não houve commit, push, merge, reset, rebase ou checkout destrutivo.
- As alterações preexistentes do workspace foram preservadas.

**Estado:** aguardando a fixture autorizada mínima e um harness não mutável. Nenhuma correção funcional foi iniciada; aguarda revisão.
