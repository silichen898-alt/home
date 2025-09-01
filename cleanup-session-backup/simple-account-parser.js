// 简化账号解析器 - 专门处理简单格式，2FA可选
class SimpleAccountParser {
  constructor() {
    this.emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
  }

  // 解析简单格式: email1 pass1 email2 pass2 或 email——password——aux_email格式 或 email|password|aux_email格式
  parseSimpleFormat(text) {
    console.log('🔍 使用简化解析器解析:', text);
    
    // 检查是否为多行格式
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    
    // 检查是否为多行三字段格式  
    if (this.isMultiLineThreeFieldFormat(lines)) {
      console.log('📋 检测到多行三字段格式，使用专用解析器');
      return this.parseMultiLineThreeFieldFormat(lines);
    }
    
    // 检查是否为行配对格式 (email password + aux_email)
    if (this.isLinePairFormat(lines)) {
      console.log('📋 检测到行配对格式，使用行配对解析器');
      return this.parseLinePairFormat(lines);
    }
    
    // 检查是否为"——"分隔符格式
    if (text.includes('——')) {
      return this.parseDashFormat(text);
    }
    
    // 检查是否包含管道符号分隔格式
    if (text.includes('|')) {
      return this.parsePipeFormat(text);
    }
    
    // 清理文本，移除多余空格和换行
    const cleanText = text.replace(/\s+/g, ' ').trim();
    
    // 分割为tokens
    const tokens = cleanText.split(' ').filter(t => t.trim().length > 0);
    console.log('📝 Tokens:', tokens);
    
    // 提取所有邮箱
    const emails = [];
    const emailIndices = [];
    
    tokens.forEach((token, index) => {
      // 如果token包含管道符号，跳过这里的邮箱提取，让它们进入管道分隔处理
      if (token.includes('|')) {
        return; // 跳过，稍后由管道分隔处理器处理
      }
      
      if (this.emailRegex.test(token)) {
        emails.push(token);
        emailIndices.push(index);
      }
    });
    
    console.log('📧 找到邮箱:', emails);
    console.log('📍 邮箱位置:', emailIndices);
    
    if (emails.length === 0) {
      return null;
    }
    
    // 解析规则：
    // 1. 如果有2个邮箱: email1 password1 email2 password2
    // 2. 如果有1个邮箱: email password [可选其他信息]
    const accounts = [];
    
    if (emails.length >= 2) {
      // 双邮箱格式: test@gmail.com pass123 aux@hotmail.com auxpass456
      const mainEmailIndex = emailIndices[0];
      const auxEmailIndex = emailIndices[1];
      
      let mainPassword = '';
      let auxPassword = '';
      
      const passwordIndicators = ['密码:', '密码：', 'password:', 'Password:', 'pass:', 'pwd:'];
      const auxiliaryIndicators = ['辅助邮箱:', '辅助邮箱：', 'auxiliary:', 'aux:'];
      
      // 主邮箱密码：跳过标识词查找密码
      let mainPasswordIndex = mainEmailIndex + 1;
      while (mainPasswordIndex < auxEmailIndex && mainPasswordIndex < tokens.length) {
        const currentToken = tokens[mainPasswordIndex];
        
        if (passwordIndicators.includes(currentToken)) {
          mainPasswordIndex++;
          continue;
        }
        
        if (currentToken.endsWith(':') || currentToken.endsWith('：')) {
          mainPasswordIndex++;
          continue;
        }
        
        mainPassword = currentToken;
        break;
      }
      
      // 辅助邮箱密码：辅助邮箱后的第一个token (通常没有标识词)
      if (auxEmailIndex + 1 < tokens.length) {
        auxPassword = tokens[auxEmailIndex + 1];
      }
      
      const account = {
        account_type: this.guessAccountType(emails[0]),
        email: emails[0],
        email_password: mainPassword,
        auxiliary_email: emails[1],
        auxiliary_email_password: auxPassword,
        two_fa_code: '', // 2FA可选，默认为空
        storage_date: this.getCurrentDate(),
        account_key: '',
        notes: `解析自文本: ${cleanText}`
      };
      
      accounts.push(account);
      console.log('✅ 解析为双邮箱账号:', account);
      
    } else if (emails.length === 1) {
      // 单邮箱格式
      const emailIndex = emailIndices[0];
      let password = '';
      
      // 密码识别逻辑：跳过标识词，找到真正的密码值
      const passwordIndicators = ['密码:', '密码：', 'password:', 'Password:', 'pass:', 'pwd:'];
      let passwordIndex = emailIndex + 1;
      
      while (passwordIndex < tokens.length) {
        const currentToken = tokens[passwordIndex];
        
        // 如果当前token是密码标识词，跳过它
        if (passwordIndicators.includes(currentToken)) {
          passwordIndex++;
          continue;
        }
        
        // 如果当前token是另一个标识词（如'辅助邮箱:'），停止搜索
        if (currentToken.endsWith(':') || currentToken.endsWith('：')) {
          break;
        }
        
        // 找到密码
        password = currentToken;
        break;
      }
      
      const account = {
        account_type: this.guessAccountType(emails[0]),
        email: emails[0],
        email_password: password,
        auxiliary_email: '',
        auxiliary_email_password: '',
        two_fa_code: '', // 2FA可选，默认为空
        storage_date: this.getCurrentDate(),
        account_key: '',
        notes: `解析自文本: ${cleanText}`
      };
      
      accounts.push(account);
      console.log('✅ 解析为单邮箱账号:', account);
    }
    
    return accounts.length > 0 ? accounts : null;
  }
  
  // 解析管道符号分隔格式: email|password|aux_email 支持混合格式
  parsePipeFormat(text) {
    console.log('🔍 检测到管道符号"|"分隔符格式，开始专门解析');
    
    // 先重组被换行分割的数据
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    console.log('📝 原始行数据:', lines);
    
    // 重组被分割的管道格式数据
    const reconstructedLines = [];
    let i = 0;
    while (i < lines.length) {
      let currentLine = lines[i];
      
      // 如果当前行以|开头，说明是被分割的数据，需要与前面的行重组
      if (currentLine.startsWith('|') && reconstructedLines.length > 0) {
        // 合并到上一行
        reconstructedLines[reconstructedLines.length - 1] += currentLine;
      } else if (!this.emailRegex.test(currentLine) && i + 1 < lines.length && lines[i + 1].startsWith('|')) {
        // 如果当前行不是邮箱但下一行以|开头，说明需要重组
        currentLine += lines[i + 1];
        j++; // 跳过下一行
        reconstructedLines.push(currentLine);
      } else {
        reconstructedLines.push(currentLine);
      }
      i++;
    }
    
    console.log('📝 重组后的行:', reconstructedLines);
    
    // 清理文本，移除多余空格
    const cleanText = reconstructedLines.join(' ').replace(/\s+/g, ' ').trim();
    console.log('📝 清理后的文本:', cleanText);
    
    // 按空格分割为段落，每个段落可能是管道分隔或普通格式
    const segments = cleanText.split(' ').filter(segment => segment.length > 0);
    console.log('📝 分割段落:', segments);
    
    const accounts = [];
    let j = 0;
    
    while (j < segments.length) {
      const segment = segments[j];
      
      // 检查是否为管道分隔格式: email|password|aux_email
      if (segment.includes('|')) {
        console.log(`🔍 解析管道分隔段落: ${segment}`);
        
        const parts = segment.split('|').map(part => part.trim());
        console.log(`📝 管道分割结果:`, parts);
        
        if (parts.length >= 3) {
          // 格式: email|password|aux_email
          const email = parts[0];
          const password = parts[1];
          const auxEmail = parts[2];
          
          // 验证主邮箱格式
          if (this.emailRegex.test(email)) {
            const account = {
              account_type: this.guessAccountType(email),
              email: email,
              email_password: password,
              auxiliary_email: auxEmail,
              auxiliary_email_password: '', // 辅助邮箱密码为空
              two_fa_code: '',
              storage_date: this.getCurrentDate(),
              account_key: '',
              notes: `解析自管道分隔格式: ${segment}`
            };
            
            accounts.push(account);
            console.log(`✅ 解析出管道分隔账号:`, account);
          }
        } else if (parts.length === 2) {
          // 格式: email|password
          const email = parts[0];
          const password = parts[1];
          
          if (this.emailRegex.test(email)) {
            const account = {
              account_type: this.guessAccountType(email),
              email: email,
              email_password: password,
              auxiliary_email: '',
              auxiliary_email_password: '',
              two_fa_code: '',
              storage_date: this.getCurrentDate(),
              account_key: '',
              notes: `解析自管道分隔格式: ${segment}`
            };
            
            accounts.push(account);
            console.log(`✅ 解析出管道分隔账号:`, account);
          }
        }
        
        j++; // 处理下一个段落
        
      } else if (this.emailRegex.test(segment)) {
        // 普通格式：邮箱后跟密码和可能的辅助邮箱
        console.log(`🔍 解析普通格式段落，起始邮箱: ${segment}`);
        
        const email = segment;
        let password = '';
        let auxEmail = '';
        
        // 查找密码（下一个非邮箱段落）
        if (j + 1 < segments.length && !this.emailRegex.test(segments[j + 1])) {
          password = segments[j + 1];
          j++; // 跳过密码段落
          
          // 查找辅助邮箱（再下一个段落如果是邮箱）
          if (j + 1 < segments.length && this.emailRegex.test(segments[j + 1])) {
            auxEmail = segments[j + 1];
            j++; // 跳过辅助邮箱段落
          }
        }
        
        // 检查是否有API key信息（在处理完基本信息后查找剩余的段落）
        let accountKey = '';
        const remainingSegments = segments.slice(j + 1);
        const apiKeys = this.extractAPIKeysFromSegments(remainingSegments);
        if (apiKeys.length > 0) {
          accountKey = apiKeys.join(',');
          // 跳过已识别为API key的段落
          j += apiKeys.length;
        }
        
        const account = {
          account_type: this.guessAccountType(email),
          email: email,
          email_password: password,
          auxiliary_email: auxEmail,
          auxiliary_email_password: '',
          two_fa_code: '',
          storage_date: this.getCurrentDate(),
          account_key: accountKey,
          notes: `解析自混合格式普通部分: ${email} ${password} ${auxEmail}${accountKey ? ' + API Keys' : ''}`
        };
        
        accounts.push(account);
        console.log(`✅ 解析出普通格式账号:`, account);
        j++; // 处理下一个段落
        
      } else if (this.isAPIKey(segment)) {
        // 如果是API Key，检查前面是否有账号需要关联
        if (accounts.length > 0) {
          const lastAccount = accounts[accounts.length - 1];
          if (!lastAccount.account_key) {
            // 将API Key关联到最近的账号
            lastAccount.account_key = segment;
            lastAccount.notes += ' + API Key';
            console.log(`✅ API Key关联到账号: ${lastAccount.email} -> ${segment}`);
          } else {
            // 已经有API Key了，添加到现有key
            lastAccount.account_key += ',' + segment;
            console.log(`✅ 额外API Key添加到账号: ${lastAccount.email} -> ${segment}`);
          }
        } else {
          console.log(`⚠️ 找到API Key但没有可关联的账号: ${segment}`);
        }
        j++;
      } else {
        // 跳过无法识别的段落
        console.log(`⚠️ 跳过无法识别的段落: ${segment}`);
        j++;
      }
    }
    
    console.log(`✅ 管道符号格式解析完成，共解析出 ${accounts.length} 个账号`);
    return accounts.length > 0 ? accounts : null;
  }
  
  // 解析多行三字段格式: email password aux_email（每行一个账号）
  parseMultiLineThreeFieldFormat(lines) {
    console.log('📋 解析多行三字段格式，总行数:', lines.length);
    const accounts = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      console.log(`📝 处理第${i+1}行:`, line);
      
      const tokens = line.split(/\s+/).filter(t => t.length > 0);
      
      // 检查是否为管道分隔格式的行
      let email, password, auxEmail;
      
      if (line.includes('|')) {
        // 管道分隔格式: email|password|aux_email
        const pipeTokens = line.split('|').map(t => t.trim()).filter(t => t.length > 0);
        if (pipeTokens.length === 3 && this.emailRegex.test(pipeTokens[0]) && this.emailRegex.test(pipeTokens[2])) {
          email = pipeTokens[0];
          password = pipeTokens[1]; 
          auxEmail = pipeTokens[2];
          console.log(`✅ 识别为管道分隔格式: ${email} | ${password} | ${auxEmail}`);
        } else {
          console.log(`⚠️ 第${i+1}行管道格式不符合要求:`, pipeTokens);
          continue;
        }
      } else if (tokens.length === 3 && 
          this.emailRegex.test(tokens[0]) && 
          !this.emailRegex.test(tokens[1]) && 
          this.emailRegex.test(tokens[2])) {
        // 空格分隔格式: email password aux_email  
        email = tokens[0];
        password = tokens[1];
        auxEmail = tokens[2];
        console.log(`✅ 识别为空格分隔格式: ${email} ${password} ${auxEmail}`);
      } else {
        console.log(`⚠️ 第${i+1}行格式不符合三字段要求:`, tokens);
        continue;
      }
      
      // 创建账号对象
      const account = {
        account_type: this.guessAccountType(email),
        email: email,
        email_password: password,
        auxiliary_email: auxEmail,
        auxiliary_email_password: '',
        two_fa_code: '',
        storage_date: this.getCurrentDate(),
        account_key: '',
        notes: `多行三字段格式解析 - 第${i+1}行`
      };
      
      accounts.push(account);
      console.log(`✅ 解析第${i+1}行账号:`, { 
        email, 
        password: password.substring(0, 3) + '***', 
        auxEmail 
      });
    }
    
    console.log(`🎉 多行三字段格式解析完成，共解析 ${accounts.length} 个账号`);
    return accounts.length > 0 ? accounts : null;
  }
  
  // 解析"——"分隔符格式: email1——password1——aux_email1 \n email2——password2——aux_email2
  parseDashFormat(text) {
    console.log('🔍 检测到"——"分隔符格式，开始专门解析');
    
    // 按行分割，每行是一个账号
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    const accounts = [];
    
    for (const line of lines) {
      console.log(`🔍 解析行: ${line}`);
      
      // 按"——"分割
      const parts = line.split('——').map(part => part.trim());
      console.log(`📝 分割结果:`, parts);
      
      if (parts.length >= 3) {
        // 格式: email——password——aux_email
        const email = parts[0];
        const password = parts[1];
        const auxEmail = parts[2];
        
        // 验证主邮箱格式
        if (this.emailRegex.test(email)) {
          const account = {
            account_type: this.guessAccountType(email),
            email: email,
            email_password: password,
            auxiliary_email: auxEmail,
            auxiliary_email_password: '', // 辅助邮箱密码为空
            two_fa_code: '',
            storage_date: this.getCurrentDate(),
            account_key: '',
            notes: `解析自"——"分隔符格式: ${line}`
          };
          
          accounts.push(account);
          console.log(`✅ 解析出账号:`, account);
        }
      } else if (parts.length === 2) {
        // 格式: email——password
        const email = parts[0];
        const password = parts[1];
        
        if (this.emailRegex.test(email)) {
          const account = {
            account_type: this.guessAccountType(email),
            email: email,
            email_password: password,
            auxiliary_email: '',
            auxiliary_email_password: '',
            two_fa_code: '',
            storage_date: this.getCurrentDate(),
            account_key: '',
            notes: `解析自"——"分隔符格式: ${line}`
          };
          
          accounts.push(account);
          console.log(`✅ 解析出账号:`, account);
        }
      }
    }
    
    console.log(`✅ "——"分隔符格式解析完成，共解析出 ${accounts.length} 个账号`);
    return accounts.length > 0 ? accounts : null;
  }
  
  // 根据邮箱域名猜测账号类型
  guessAccountType(email) {
    const domain = email.split('@')[1].toLowerCase();
    
    if (domain.includes('gmail')) return 'Gmail';
    if (domain.includes('outlook') || domain.includes('hotmail')) return 'Outlook';
    if (domain.includes('yahoo')) return 'Yahoo';
    if (domain.includes('icloud')) return 'iCloud';
    
    return '其他邮箱';
  }
  
  // 添加别名方法修复错误调用
  getAccountType(email) {
    return this.guessAccountType(email);
  }
  
  // 获取当前日期
  getCurrentDate() {
    return new Date().toISOString().split('T')[0];
  }
  
  // 从段落中提取API密钥
  extractAPIKeysFromSegments(segments) {
    const apiKeys = [];
    const apiKeyPattern = /^AIzaSy[A-Za-z0-9_-]{33}$/;
    
    for (const segment of segments) {
      if (apiKeyPattern.test(segment.trim())) {
        apiKeys.push(segment.trim());
      }
    }
    
    return apiKeys;
  }
  
  // 检查是否为API Key
  isAPIKey(segment) {
    const trimmed = segment.trim();
    // Google API Key 格式：AIzaSy + 33个字符 = 总共39个字符
    const apiKeyPattern = /^AIzaSy[A-Za-z0-9_-]{33}$/;
    return apiKeyPattern.test(trimmed);
  }
  
  // 检查是否为多行三字段格式（email password email）
  isMultiLineThreeFieldFormat(lines) {
    if (lines.length < 2) return false;
    
    let validLines = 0;
    for (const line of lines) {
      // 检查管道分隔格式的行
      if (line.includes('|')) {
        const pipeTokens = line.split('|').map(t => t.trim()).filter(t => t.length > 0);
        if (pipeTokens.length === 3 && this.emailRegex.test(pipeTokens[0]) && this.emailRegex.test(pipeTokens[2])) {
          validLines++;
          continue;
        }
      }
      
      // 检查空格分隔格式的行
      const tokens = line.split(/\s+/).filter(t => t.length > 0);
      if (tokens.length === 3) {
        // 第1个和第3个字段应该是邮箱
        if (this.emailRegex.test(tokens[0]) && this.emailRegex.test(tokens[2])) {
          // 第2个字段应该不是邮箱（应该是密码）
          if (!this.emailRegex.test(tokens[1]) && tokens[1].length >= 4) {
            validLines++;
          }
        }
      }
    }
    
    // 如果至少有2行符合格式，认为是多行三字段格式
    return validLines >= 2;
  }
  
  // 检查是否为简单格式
  isSimpleFormat(text) {
    const cleanText = text.replace(/\s+/g, ' ').trim();
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    
    // 1. 检查多行三字段格式（每行: email password email）
    if (this.isMultiLineThreeFieldFormat(lines)) {
      console.log('🔍 检测到多行三字段格式');
      return true;
    }
    
    const tokens = cleanText.split(' ');
    
    // 简单格式特征：
    // 1. 包含邮箱
    // 2. tokens数量合理 (2-8个) 或 包含管道符号分隔
    // 3. 没有复杂的标识符
    // 4. 没有时间戳格式
    // 5. 没有聊天记录格式
    
    // 统计邮箱数量，包括管道分隔格式中的邮箱
    let emailCount = 0;
    tokens.forEach(token => {
      if (token.includes('|')) {
        // 管道分隔格式，统计其中的邮箱
        const parts = token.split('|');
        parts.forEach(part => {
          if (this.emailRegex.test(part)) {
            emailCount++;
          }
        });
      } else if (this.emailRegex.test(token)) {
        emailCount++;
      }
    });
    
    // 如果包含管道符号，则认为是简单管道格式
    if (text.includes('|') && emailCount >= 1) {
      return true;
    }
    
    // 传统简单格式检查
    const emails = tokens.filter(token => this.emailRegex.test(token));
    
    return emails.length >= 1 && 
           tokens.length >= 2 && 
           tokens.length <= 8 &&
           !text.includes('---') &&
           !text.includes('2fa') &&
           !text.includes('Gmail:') &&
           !text.includes('[2025') &&  // 排除时间戳格式
           !text.includes('google cloud') &&  // 排除聊天记录格式
           !text.includes('GCP:') &&  // 排除GCP格式
           !text.includes('Homie,') &&  // 排除聊天用户名
           !this.isCSVLikeFormat(text) &&  // 排除CSV格式
           lines.length <= 10;  // 允许更多行数以支持批量数据
  }
  
  // 检查是否为CSV类格式（包含逗号分隔的格式）
  isCSVLikeFormat(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    
    // 检查是否有包含多个逗号的行，且逗号前后有邮箱或其他数据
    for (const line of lines) {
      if (line.includes(',')) {
        const commaCount = (line.match(/,/g) || []).length;
        // 如果一行有3个以上逗号，很可能是CSV格式
        if (commaCount >= 3) {
          return true;
        }
        
        // 或者行中包含邮箱且有逗号分隔，也可能是CSV
        if (this.emailRegex.test(line) && commaCount >= 2) {
          return true;
        }
      }
    }
    
    return false;
  }
  
  // 检查是否为行配对格式 (email password + aux_email 分行显示)
  isLinePairFormat(lines) {
    if (lines.length < 4 || lines.length % 2 !== 0) return false;
    
    let validPairs = 0;
    for (let i = 0; i < lines.length; i += 2) {
      const line1 = lines[i];
      const line2 = lines[i + 1];
      
      if (!line2) break;
      
      // 第一行：应该是 email password (2个字段)
      const tokens1 = line1.split(/\s+/).filter(t => t.length > 0);
      if (tokens1.length !== 2) continue;
      if (!this.emailRegex.test(tokens1[0])) continue;
      if (this.emailRegex.test(tokens1[1])) continue; // 密码不应该是邮箱
      
      // 第二行：应该是 aux_email (1个字段)
      const tokens2 = line2.split(/\s+/).filter(t => t.length > 0);
      if (tokens2.length !== 1) continue;
      if (!this.emailRegex.test(tokens2[0])) continue;
      
      validPairs++;
    }
    
    return validPairs >= 2; // 至少2对才认为是行配对格式
  }
  
  // 解析行配对格式
  parseLinePairFormat(lines) {
    console.log('🔍 使用行配对解析器解析');
    const accounts = [];
    
    for (let i = 0; i < lines.length; i += 2) {
      const line1 = lines[i];
      const line2 = lines[i + 1];
      
      if (!line2) break;
      
      const tokens1 = line1.split(/\s+/).filter(t => t.length > 0);
      const tokens2 = line2.split(/\s+/).filter(t => t.length > 0);
      
      if (tokens1.length !== 2 || tokens2.length !== 1) continue;
      if (!this.emailRegex.test(tokens1[0]) || !this.emailRegex.test(tokens2[0])) continue;
      
      const account = {
        account_type: this.guessAccountType(tokens1[0]),
        email: tokens1[0],
        email_password: tokens1[1],
        auxiliary_email: tokens2[0],
        auxiliary_email_password: '',
        two_fa_code: '',
        storage_date: new Date().toISOString().split('T')[0],
        account_key: '',
        notes: `解析自行配对格式: ${line1} + ${line2}`
      };
      
      console.log(`✅ 解析账号${accounts.length + 1}: ${account.email} | ${account.email_password} | ${account.auxiliary_email}`);
      accounts.push(account);
    }
    
    console.log(`✅ 行配对解析完成，共解析出 ${accounts.length} 个账号`);
    return accounts;
  }
}

module.exports = SimpleAccountParser;