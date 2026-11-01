# Auditoria CSC, alias e QR Code — rejeição 464

Auditoria somente de leitura. Nenhuma NFC-e foi transmitida nesta auditoria. O banco oficial não foi aberto. O segredo CSC não foi lido, impresso nem gravado. A regra de recomposição e o cálculo do QR Code não foram alterados.

## Nota analisada

NFC-e de homologação montada pelo processo em execução, em 2026-11-01T15:29:52-03:00.

| Campo | Valor observado |
|---|---|
| Chave | `23261165957340000150650010000010231577252107` |
| CNPJ na chave e no emitente | `65957340000150` |
| UF | CE (`cUF` 23) |
| `tpAmb` | 2 |
| Certificado | mesmo CNPJ, titular ESQUINAO DA ECONOMIA LTDA |
| QR Code | `https://nfceh.sefaz.ce.gov.br/pages/ShowNFCe.html?p=<chave>\|2\|2\|1\|7F671C611D1C2716D62F1B08549192B55810B1FC` |
| Versão do QR | 2 |
| Identificador CSC no QR | 1 |
| Hash no QR | `7F671C611D1C2716D62F1B08549192B55810B1FC` |
| Rejeição informada | 464 — código de hash do QR Code difere do calculado |

O hash impresso no XML é o mesmo hash que o processo registrou no log `[FISCAL QRCODE AUDIT]` dessa emissão. O XML, a chave e o QR Code saíram do mesmo cálculo.

## 1. Origem do CNPJ e da configuração

A emissão da venda usa `vendas.empresa_id`. `FiscalEmpresaContextoService.resolverCredenciaisNfceDaEmpresa` exige `getFiscalConfig` com essa empresa e recusa configuração cuja `fonte` não seja `EMPRESA`.

Nesta nota o log foi:

- `empresa_id: 1`
- `origem: CONFIGURACAO_EMPRESA`
- `ambiente: HOMOLOGACAO`

O CNPJ do XML não vem da tabela global `configuracoes`. Vem de `empresas.cnpj` da empresa 1, montado em `montarConfigEmpresa`. A chave de acesso e o certificado repetem `65957340000150`. Emitente, chave e certificado são a mesma empresa.

A URL de autorização foi a de homologação da SVRS. A URL do QR Code foi a de homologação da SEFAZ-CE. Esse par é o caminho da NFC-e do Ceará. Não explica a rejeição 464.

Não existe variável de ambiente de CSC. `backend/config/secrets.js` não guarda CSC. Não há cache em memória do token: cada emissão chama `getFiscalConfig` de novo. O log de carga e o log do QR Code são do mesmo segundo.

## 2. Alias efetivamente carregado

Não existe alias de CSC no código. A busca por um resolvedor de alias de CSC não encontrou tabela, variável nem função.

O que a tela chama de valor já configurado é o texto fixo `CONFIGURADO — informe para substituir` (`PLACEHOLDER_CSC_UI`). O campo do token abre vazio. Se o operador salva sem digitar outro segredo, `montarPayloadFiscal` omite `token_csc` e `salvarConfiguracaoFiscalEmpresa` mantém o token que já estava na linha da empresa.

Esse placeholder é o único substituto do segredo. Ele não escolhe um CSC novo. Ele conserva o anterior.

## 3. Identificador CSC utilizado

O QR Code e o log usam o identificador `1`.

`gerarQRCodeNFCe` converte `idCSC` com `Number`. `000001` vira `1`. Identificador vazio também vira `1`. A reprodução sintética confirmou os dois casos. Nesta nota o identificador efetivo foi `1`, não um identificador vazio mascarado: o log imprime `ID CSC: 1` a partir do valor já carregado da empresa.

## 4. Ambiente selecionado

Ambiente 2, homologação. O `tpAmb` do XML, o parâmetro do QR Code e o bloco de URLs carregado são o mesmo. A coluna da empresa é um único `ambiente`. Não há CSC separado para homologação e produção: existe um `token_csc` e um `id_csc` para a empresa inteira.

## 5. Empresa, alias e ambiente

| Exigência | O que o código faz |
|---|---|
| CSC do CNPJ `65957340000150` | Não verifica. Usa o `token_csc` da empresa 1, seja qual for o CNPJ atual |
| CSC do Ceará | Não verifica a UF do token. A UF sai de `empresas_configuracao_fiscal.uf` |
| CSC de homologação | Não há coluna de token por ambiente |
| Identificador igual ao do QR Code | O QR usa o `id_csc` da mesma linha, normalizado para `1` |
| Alias novo | Não há alias. Salvar sem token novo conserva o token anterior |

A configuração global `fiscal_token_csc` não entrou nesta emissão. A origem foi `CONFIGURACAO_EMPRESA`. Não houve fallback silencioso para a configuração global. O fallback silencioso que existe é outro: conservar o `token_csc` já gravado quando o formulário vai com o placeholder.

Uma segunda NFC-e do mesmo processo, às 15:36, também saiu da empresa 1, em homologação, com identificador `1` e outro hash, porque a chave era outra. O mesmo token produz hashes diferentes para chaves diferentes. Isso não indica troca de CSC no meio do processo.

## 6. Função e parâmetros do hash

Função: `gerarQRCodeNFCe` em `backend/services/fiscal/qrcode.js`, chamada por `emitirPorVendaId` com `config.idCSC`, `config.tokenCSC`, `config.ambiente` e a URL de consulta do ambiente.

Ordem, versão 2 online:

`SHA-1( chave + "|" + "2" + "|" + tpAmb + "|" + idCSC + CSC )`

O CSC entra colado ao identificador, sem outro `|`. O resultado é hexadecimal maiúsculo. O identificador no hash é o mesmo identificador da URL.

Para esta nota a parte visível, sem o segredo, foi:

`23261165957340000150650010000010231577252107|2|2|1`

## 7. Comparação do hash

Reprodução independente com segredo sintético, sem usar o CSC real:

| Prova | Resultado |
|---|---|
| `gerarQRCodeNFCe` e `crypto.createHash('sha1')` com o mesmo segredo sintético | hashes iguais |
| Outro segredo sintético | hash diferente |
| Mesmo segredo com identificador `2` | hash diferente |
| Identificador vazio | a função usa `1` |
| Hash publicado da NFC-e e hash do segredo sintético | diferentes, como esperado |

O hash publicado `7F671C611D1C2716D62F1B08549192B55810B1FC` é exatamente o hash que o processo calculou para essa chave, ambiente 2 e identificador 1. O CDS e o XML concordam entre si. A SEFAZ discorda. A divergência está no segredo aplicado depois de `|1`, não na ordem, no SHA-1, na chave nem no `tpAmb`.

O segredo gravado não foi lido. Por isso não há comparação byte a byte com o CSC novo do portal.

## 8. Causa raiz

A rejeição 464 ocorre porque o SHA-1 foi feito com um CSC que a SEFAZ-CE não reconhece para o CNPJ `65957340000150`, em homologação, no identificador `1`.

O algoritmo está de acordo com o QR Code versão 2. A empresa, o certificado e a chave são o Esquinão. O que não acompanha a troca da matriz é o segredo:

- a empresa 1 tem um único `token_csc`;
- trocar a razão social e o CNPJ não troca esse token;
- a tela não mostra o token e, se o campo segue vazio, o save conserva o valor antigo;
- não existe alias que aponte para o CSC novo;
- identificador em branco é emitido como `1`;
- nada impede usar, nesse identificador, o CSC da empresa anterior ou o CSC de outro ambiente.

A evidência que ainda falta, e que esta auditoria não coletou, é a conferência do token gravado na empresa 1 com o CSC de homologação emitido pela SEFAZ para `65957340000150` e para o identificador `1`. Essa conferência precisa ser feita fora do banco oficial, comparando apenas um resumo irreversível, sem exibir o segredo.

## 9. Menor correção recomendada

Não foi implementada.

1. Se o CNPJ da empresa mudar, não conservar o `token_csc` anterior. Exigir o identificador e o segredo novos antes de salvar.
2. Não transformar identificador vazio em `1`. Sem identificador, a emissão para.
3. Gravar o token de homologação separado do token de produção e usar só o do `tpAmb` da nota.
4. Não criar alias nem voltar a ler `fiscal_token_csc` global.

Enquanto isso, a emissão desta empresa só fecha o QR Code se o token gravado for o CSC de homologação da SEFAZ-CE para este CNPJ e se o identificador gravado for o mesmo identificador desse CSC. O identificador usado na nota rejeitada foi `1`.
