# Sprint MIIP V2 — Instrumentação diagnóstica da origem do candidato

**Tipo:** instrumentação opt-in e testes isolados; nenhuma regra de identificação foi alterada.  
**Ocorrência original:** ainda não diagnosticada. Os eventos e exemplos abaixo são sintéticos; não foram obtidos de um documento real.  
**Persistência:** os novos eventos são voláteis e não são gravados no SQLite nem anexados ao candidato.

## 1. O que já existia e o que faltava

Os resultados MIIP já carregam parte substancial da evidência necessária:

- `produtoEncontrado` e `candidatoSelecionado`;
- score e motor;
- evidências do motor;
- `motoresQueVotaram`;
- atributos extraídos, incluindo `origemDados`, motivos de relevância e motivos de consulta, quando fornecidos;
- `operacaoId` no resultado da importação.

O processamento Central também já informa `reutilizado`, `recuperado` e `etapasPuladas`; isso distingue o reuso de um resultado persistido de uma identificação recém-executada no serviço. A interface recebia o snapshot MIIP e o catálogo atual, mas não registrava qual fonte prevaleceu em nome, código e GTIN.

Faltava uma trilha segura e correlacionável para:

1. hit/miss dos caches de produto do MIIP e do catálogo MIP;
2. candidatos e motivos devolvidos pela busca universal do catálogo;
3. resultado persistido reutilizado versus resultado recém-calculado;
4. fontes inferíveis no candidato selecionado e alternativas;
5. origem efetivamente usada pela interface para cada campo de identidade.

As evidências do motor não são recalculadas. A instrumentação registra tipos/códigos já existentes, não os valores de entrada nem o XML.

## 2. Instrumentação adicionada

O módulo `backend/motores/miip/diagnostics/MiipOriginDiagnostics.js` fornece um coletor somente em memória. O backend escreve JSON no `stdout` com prefixo `[MIIP_ORIGIN_DIAG]` somente quando **todas** estas condições são verdadeiras:

- `NODE_ENV=test`;
- `CDS_MIIP_ORIGIN_DIAGNOSTICS=1`;
- `DB_DIR` resolve para um diretório filho da pasta temporária do sistema (`os.tmpdir()`).

O valor de `DB_DIR` e qualquer caminho de banco nunca são incluídos nos eventos. A condição impede habilitação acidental em produção, fora do modo de teste ou apontando para um diretório do workspace/ProgramData.

Os eventos podem incluir:

- horário, ID interno do documento e `operacaoId` interno, quando seguro;
- origem do resultado (`novo_processamento`, `persistido_reutilizado` ou `desconhecida`);
- ID do produto, motor, score original, score do candidato, tipos de evidência e motivos de relevância;
- fontes inferidas (`busca_gtin`, `associacao_fornecedor`, `busca_textual_ncm`) ou `desconhecida`;
- tipo de lookup, hit/miss de cache, fonte (`produto_cache`/`sqlite`) e contexto (`sqlite_injetado`/`sqlite_padrao`);
- origem de cada campo da identidade exibida (`snapshot_miip`, `catalogo_atual` ou `desconhecida`).

Por privacidade, não são emitidos XML, GTIN, código interno/fornecedor, descrição/nome, CNPJ, nome de fornecedor, valores de evidência, parâmetros de SQL, caminhos de banco ou mensagens de erro. Identificadores de operação contendo sequência numérica longa são omitidos para não confundir chave fiscal/código com ID interno. Evidências são representadas por motor, tipo e score; motivos por seus códigos.

Para que a coleta opt-in não duplique os logs existentes com valores sensíveis, durante esse mesmo modo de teste:

- `MiipIntegracaoLogService` mantém apenas o `produtoIdHint` no resumo do item, redige motivo/erro e não imprime identificação fiscal;
- `MiipMotorLogService` omite identificadores do item, CNPJ/código/contexto e redige erros no buffer volátil;
- mensagens debug do `ProdutoIdentidadeCatalogo` e do `ProdutoIdentidadeService` são suprimidas; erros MIP emitidos nesse modo não incluem o código consultado nem a mensagem bruta.

Fora do modo opt-in descrito acima, os comportamentos existentes desses logs permanecem inalterados.

### Eventos cobertos

- `CentralProcessamentoService` registra cada item no caminho de reuso e no caminho de processamento/recuperação. O campo de origem se refere especificamente à etapa MIIP, não apenas ao status geral do pipeline.
- `MiipImportacaoXmlService` associa o contexto de operação interno ao escopo assíncrono quando disponível.
- `ProdutoRepository` registra lookups por ID/GTIN e hits/misses do `ProdutoCache`; a busca universal registra IDs dos candidatos e motivos de busca.
- `ProdutoIdentidadeCatalogo` registra lookups por ID, código, GTIN/identificador e hits/misses de `MipLookupCache`.
- Candidatos finais preservam as fontes que o resultado já traz; associações são descritas como tal somente quando há metadado/motor correspondente. A lista de fontes pode conter mais de uma fonte.
- A interface só emite o evento de identidade quando o operador habilita o flag global no navegador de teste. O evento contém a origem de nome/código/GTIN e score original, sem imprimir os valores dos campos.

Se os dados de origem não estão no resultado, o evento não os inventa: registra `desconhecida`.

## 3. Como habilitar apenas em teste isolado

### Backend

Inicie um processo isolado com cópia autorizada ou DB temporário, nunca com o banco oficial. Exemplo PowerShell:

```powershell
$isolatedDbDir = Join-Path $env:TEMP ("miip-origin-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $isolatedDbDir | Out-Null
$env:NODE_ENV = "test"
$env:CDS_MIIP_ORIGIN_DIAGNOSTICS = "1"
$env:DB_DIR = $isolatedDbDir
```

Em seguida, execute o harness de teste/aplicação aprovado nesse processo. Se for usar cópia de banco, coloque **somente a cópia autorizada** nesse diretório e confirme o escopo antes de iniciar. Para teste unitário, o banco usado aqui foi SQLite `:memory:`; `DB_DIR` temporário foi apenas a trava exigida para habilitar os eventos. Não ative `MIP_DEBUG`.

Os eventos aparecem como linhas:

```text
[MIIP_ORIGIN_DIAG] {"timestamp":"...","evento":"...","documentoId":7001,...}
```

Não use o caminho `backend\banco\mercadao.db` enquanto sua procedência/autorização não estiver confirmada. Não configure `DB_DIR` para ProgramData ou para o banco oficial. O módulo não abre nem escolhe banco por conta própria.

### Interface

Em uma janela de navegador Electron apontada exclusivamente para a aplicação de teste autorizada, habilite o observador volátil antes de abrir a revisão:

```javascript
window.CDS_MIIP_ORIGIN_DIAGNOSTICS = true;
```

O evento `campos_identidade_ui` aparece no console do navegador. O flag não persiste após recarregar a página. Não habilite no ERP de produção. A validação visual da tela não foi executada nesta sprint; a página compartilhada anteriormente retornou HTTP 403, que não foi contornado.

## 4. Exemplos sintéticos de saída

Exemplo de resultado MIIP sintético:

```json
{
  "timestamp": "2026-10-20T00:00:00.000Z",
  "documentoId": 7001,
  "operacaoId": "op-miip-teste-01",
  "evento": "resultado_item",
  "indiceItem": 0,
  "origemResultado": "novo_processamento",
  "candidatos": [
    {
      "produtoId": 42,
      "motor": "motor_mubc",
      "fontes": ["busca_textual_ncm"],
      "scoreOriginal": 74,
      "scoreCandidato": 74,
      "evidencias": [
        {"motor": "motor_mubc", "tipo": "descricao", "score": 74}
      ],
      "motivosRelevancia": ["descricao", "ncm"],
      "origemCamposIdentidade": {
        "nome": "snapshot_miip",
        "codigo": "snapshot_miip",
        "gtin": "snapshot_miip"
      }
    }
  ]
}
```

Exemplo sintético de cache:

```json
{
  "timestamp": "2026-10-20T00:00:01.000Z",
  "documentoId": 7001,
  "operacaoId": "op-miip-teste-01",
  "evento": "consulta_produto",
  "tipoConsulta": "gtin",
  "cacheHit": true,
  "produtoId": 42,
  "fonteConsulta": "produto_cache",
  "contextoCatalogo": "sqlite_injetado"
}
```

Exemplo sintético emitido pela interface:

```json
{
  "timestamp": "2026-10-20T00:00:02.000Z",
  "evento": "campos_identidade_ui",
  "documentoId": 7001,
  "operacaoId": "op-miip-teste-01",
  "produtoId": 42,
  "scoreOriginal": 74,
  "origemCamposIdentidade": {
    "nome": "snapshot_miip",
    "codigo": "snapshot_miip",
    "gtin": "catalogo_atual"
  }
}
```

Os exemplos não representam a ocorrência `ABC001` nem comprovam a causa dos 58%.

## 5. Arquivos alterados e componentes reutilizados

- `backend/motores/miip/diagnostics/MiipOriginDiagnostics.js` — gate de ambiente, correlação assíncrona e serialização allowlist de eventos.
- `backend/motores/miip/repositories/ProdutoRepository.js` — eventos de hit/miss do cache MIIP e candidatos/MUBC retornados do catálogo.
- `backend/motores/miip/services/MiipImportacaoXmlService.js` — associa o ID de operação interno ao contexto de diagnóstico quando seguro.
- `backend/motores/central-entradas/services/CentralProcessamentoService.js` — marca reuso ou novo resultado por item sem alterar o resultado funcional. Este arquivo já tinha alterações locais preexistentes antes desta sprint; elas foram preservadas.
- `backend/motores/produto-identidade/services/ProdutoIdentidadeCatalogo.js` — eventos do cache/consulta MIP por tipo de lookup; debug bruto suprimido somente durante a coleta de teste.
- `backend/motores/produto-identidade/services/ProdutoIdentidadeService.js` — debug bruto do MIP suprimido/redigido somente durante a coleta de teste.
- `frontend/erp/js/miip-central-revisao-inteligente.js` e `frontend/erp/js/miip-central-revisao.js` — evento volátil opt-in com a precedência de identidade mostrada na UI.
- `tests/miip/miip-origin-diagnostics.test.js` — testes sintéticos isolados.
- Este relatório.

`MiipIntegracaoLogService.js` e `MiipMotorLogService.js` já contêm no estado atual os hooks de redação usados no modo diagnóstico, mas não têm diff nesta entrega; foram reutilizados. `CentralProcessamentoService.js` já tinha alterações locais preexistentes antes desta sprint, preservadas junto aos novos hooks. As alterações locais preexistentes em outros arquivos, inclusive em testes, também foram preservadas.

## 6. Testes e validação executados

Todos os testes abaixo foram executados por `node` diretamente. O executor integrado não reconheceu esses arquivos autônomos e retornou “No tests found”; não foi tratado como aprovação.

| Teste | Resultado |
|---|---|
| `node tests/miip/miip-origin-diagnostics.test.js` | **8 passou, 0 falhou.** Gate; busca atual com GTIN divergente; persistência/reuso; cache MIIP e MIP; associação; origem desconhecida; redaction; imutabilidade. Usa SQLite `:memory:` e diretório temporário para habilitar o gate. |
| `node tests/miip/miip-importacao-xml.test.js` | **12 passou, 0 falhou.** |
| `node tests/miip/motor-mubc.test.js` | **13 ok, 0 falhou.** |
| `node tests/miip/motor-associacao-fornecedor.test.js` | **17 passou, 0 falhou.** |
| `node tests/miip/miip-central-revisao.test.js` | **10 passou, 0 falhou.** |
| `node tests/miip/miip-rc94-ux.test.js` | **10 ok, 0 falha(s).** |
| `node tests/produto-identidade/mip-sprint03-miip.test.js` com `DB_DIR` temporário | **6 ok, 0 falha(s).** |
| `node tests/central-entradas/microsprint-26-recuperacao-processamento.test.js` | **10 passou, 0 falhou.** |
| `node tests/central-entradas/microsprint-27-estabilizacao.test.js` | **5 passou, 0 falhou.** |
| `node tests/central-entradas/isolamento-fila-processamento-05-74.test.js` | **12/12 OK.** |
| `node tests/central-entradas/rc1-consolidacao.test.js` | **9 passou, 0 falhou.** |

Total: **112 testes/assertions reportados como aprovados** nos comandos acima. Os testes Central que inicializaram bancos usaram seus mecanismos de isolamento em diretórios temporários. A execução MIP com `DB_DIR` temporário removeu seu diretório ao terminar.

Nos testes de Central, as rotinas de schema imprimiram avisos `SQLITE_ERROR: duplicate column name` ao tentar adicionar colunas já presentes, além de um aviso de dependência circular Node em alguns processos. Os comandos concluíram com exit code 0 e os testes reportaram zero falhas. Esses avisos não foram corrigidos, pois são preexistentes e fora do escopo da instrumentação.

Também passaram `node --check` para os arquivos JavaScript alterados e `git diff --check` nos arquivos tocados.

## 7. Exemplo do que a suíte efetivamente verificou

- Uma busca MUBC sintética localizou candidato por descrição/NCM embora o GTIN do produto fosse diferente do GTIN pesquisado; o score sintético não foi atribuído ao caso real.
- Uma consulta por ID/GTIN retornou snapshot cacheado após alteração sintética do registro em SQLite `:memory:`; o evento identificou o hit sem revelar a chave consultada.
- O cache MIP registrou miss seguido de hit por GTIN após alteração sintética do catálogo.
- O `CentralProcessamentoService` reconheceu `persistido_reutilizado`; parser e MIIP foram configurados para falhar se reexecutados e não foram chamados.
- Associação fornecedor + código foi testada com valores fictícios; o evento indicou `associacao_fornecedor`, sem incluir CNPJ/código.
- Dados sem metadados foram registrados como `desconhecida`.
- Serializações do candidato, score, contagem do catálogo e campos exibidos permaneceram inalterados; a instrumentação não escreveu dados funcionais no SQLite em memória.

Esses testes provam o comportamento dos mecanismos no ambiente sintético. Não diagnosticam a ocorrência original.

## 8. Limitações, riscos e coleta autorizada

- A origem do candidato `Refrigerante Cola 2L / ABC001 / 7891234567890 / 58%` continua **inconclusiva**. Falta uma cópia autorizada e isolada do documento/catálogo ou export mínimo do resultado persistido e do registro do `produto_id`.
- O evento do cache ocorre no instante do lookup. Se o ID de operação seguro ainda não foi produzido, pode conter apenas `documentoId` e timestamp; o evento final do candidato registra o `operacaoId` seguro ou `null` se o valor puder ser chave fiscal. Não se inventa uma correlação ausente.
- A origem pode conter múltiplas fontes. Eventos do MUBC registram os motivos que a busca retornou; evento final registra o motor/fonte que o resultado final preservou. Uma fonte sem evidência observável é `desconhecida`.
- O `stdout`/console pode ser capturado pelo terminal, host ou ferramenta de teste. Proteja os arquivos de saída como dados de diagnóstico e use somente ambiente controlado e export minimizado. A instrumentação não grava em banco, mas não controla retenção externa do console.
- Os logs MIIP preexistentes podem guardar dados em buffers em memória. No modo diagnóstico habilitado, os caminhos acima redigem os campos de item; demais logs externos ao MIIP não foram alterados.
- O teste visual do browser não foi executado; HTTP 403 continua sem contorno.
- Não foi usada a base `backend\banco\mercadao.db`, cuja procedência/autorização permanece desconhecida. O banco oficial não foi aberto nem consultado.

### Procedimento mínimo para a futura reprodução

1. Obter autorização e criar uma cópia isolada/minimizada do banco ou fixture equivalente; substituir CNPJ/nome do fornecedor por valores sintéticos sempre que isso preservar a relação usada na associação.
2. Definir `NODE_ENV=test`, `CDS_MIIP_ORIGIN_DIAGNOSTICS=1` e `DB_DIR` dentro de um subdiretório temporário **antes** de iniciar o backend.
3. Não habilitar `MIP_DEBUG`; a instrumentação controla os logs debug de MIP sensíveis durante o modo diagnóstico.
4. Processar apenas o documento de teste autorizado, sem operações SEFAZ; coletar `[MIIP_ORIGIN_DIAG]` junto ao registro da UI `campos_identidade_ui`.
5. Correlacionar por `documentoId`, `operacaoId` seguro, `produtoId` e timestamp; comparar com o registro do produto na cópia isolada. Não exportar o XML nem campos fiscais/pessoais.
6. Desabilitar o flag, encerrar o processo e remover somente o diretório temporário criado para essa reprodução.

## 9. Confirmações de segurança e estado

- Nenhum banco oficial ou `backend\banco\mercadao.db` foi aberto, consultado ou alterado.
- Testes de banco usaram `:memory:` ou diretórios temporários isolados.
- Nenhum XML real foi processado, nenhuma operação real na SEFAZ foi executada e nenhum HTTP 403 foi contornado.
- Não foram alterados scores, candidatos, regras de decisão, associações ou persistência funcional.
- Nenhum evento diagnóstico novo foi gravado em banco.
- Nenhuma cache operacional foi limpa ou invalidada; as limpezas do singleton/cache ocorreram somente nos processos de teste isolados.
- Não houve commit, push, merge, reset, rebase ou checkout destrutivo.
- As alterações preexistentes do workspace foram preservadas. Nenhuma correção das regras MIIP/MIP/MUBC ou dos caches foi iniciada.

**Estado:** instrumentação concluída para coleta em ambiente de teste opt-in. Aguarda revisão antes de qualquer correção funcional.
