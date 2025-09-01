// 智能数据解析器 - 从原始文本中提取账号信息
const MultiAccountFormatParser = require('./parse-multi-account-format');
const SimpleAccountParser = require('./simple-account-parser');

class SmartDataParser {
  constructor() {
    // 邮箱正则表达式
    this.emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    
    // 密码可能的前缀标识
    this.passwordIndicators = [
      '密码', 'password', 'pwd', 'pass', '密碼', 'mima',
      '：', ':', '是', '-', '为', '|'
    ];
    
    // 2FA相关标识
    this.twoFAIndicators = [
      '2fa', '2FA', 'totp', 'TOTP', '两步验证', '二次验证', 
      '验证码', 'authentication', 'authenticator'
    ];
    
    // 多账号格式解析器
    this.multiAccountParser = new MultiAccountFormatParser();
    
    // 简化解析器
    this.simpleParser = new SimpleAccountParser();
  }

  // 解析原始文本数据
  parseRawData(rawText, accountType = '') {
    console.log('🔍 开始智能解析数据...');
    
    // 最优先检查是否为简单格式（包括多行三字段格式）
    if (this.simpleParser.isSimpleFormat(rawText)) {
      console.log('📌 检测到简单格式，使用简化解析器');
      const simpleResult = this.simpleParser.parseSimpleFormat(rawText);
      if (simpleResult && simpleResult.length > 0) {
        console.log(`✅ 简化解析成功，解析出 ${simpleResult.length} 个账号`);
        return simpleResult;
      }
    }
    
    // 其次检查是否为CSV格式
    if (this.isCSVFormat(rawText)) {
      console.log('📌 检测到CSV格式，使用CSV解析器');
      const csvResult = this.parseCSVFormat(rawText);
      if (csvResult && csvResult.length > 0) {
        console.log(`✅ CSV解析成功，解析出 ${csvResult.length} 个账号`);
        return csvResult;
      }
    }
    
    // 然后检查是否为三行一组格式（修复版）
    if (this.isThreeLineFormat(rawText)) {
      console.log('📌 检测到三行一组格式，使用专用解析器');
      const threeLineResult = this.parseThreeLineFormat(rawText);
      if (threeLineResult && threeLineResult.length > 0) {
        console.log(`✅ 三行一组解析成功，解析出 ${threeLineResult.length} 个账号`);
        return threeLineResult;
      }
    }
    
    // 检查是否为"CSV行+API Key行"格式
    if (this.isCSVWithAPIKeysFormat(rawText)) {
      console.log('📌 检测到CSV行+API Key行格式，使用专用解析器');
      const csvApiResult = this.parseCSVWithAPIKeysFormat(rawText);
      if (csvApiResult && csvApiResult.length > 0) {
        console.log(`✅ CSV行+API Key行解析成功，解析出 ${csvApiResult.length} 个账号`);
        return csvApiResult;
      }
    }
    
    // 检查是否为"账号行+API Key行"格式
    if (this.isAccountWithAPIKeysFormat(rawText)) {
      console.log('📌 检测到账号行+API Key行格式，使用专用解析器');
      const accountApiResult = this.parseAccountWithAPIKeysFormat(rawText);
      if (accountApiResult && accountApiResult.length > 0) {
        console.log(`✅ 账号行+API Key行解析成功，解析出 ${accountApiResult.length} 个账号`);
        return accountApiResult;
      }
    }
    
    // 首先检查是否为混合格式（包含聊天记录时间戳）
    const mixedFormatResult = this.parseMixedChatFormat(rawText);
    if (mixedFormatResult && mixedFormatResult.length > 0) {
      console.log(`📌 检测到混合聊天格式，解析出 ${mixedFormatResult.length} 个账号`);
      return mixedFormatResult;
    }
    
    // 检查是否为多邮箱共享密码格式
    const sharedPasswordResult = this.parseSharedPasswordFormat(rawText);
    if (sharedPasswordResult && sharedPasswordResult.length > 0) {
      console.log(`📌 检测到多邮箱共享密码格式，解析出 ${sharedPasswordResult.length} 个账号`);
      return sharedPasswordResult;
    }
    
    // 检查是否为多账号连续格式
    if (this.multiAccountParser.isMultiAccountFormat(rawText)) {
      console.log('📌 检测到多账号连续格式');
      const results = this.multiAccountParser.parseMultiAccountFormat(rawText);
      console.log(`✅ 成功解析 ${results.length} 条记录（多账号格式）`);
      return results;
    }
    
    // 分割文本为记录块
    const records = this.splitIntoRecords(rawText);
    const parsedData = [];
    
    for (const record of records) {
      const parsed = this.parseRecord(record, accountType);
      if (parsed && (parsed.email || parsed.auxiliary_email)) {
        parsedData.push(parsed);
      } else {
      }
    }
    
    console.log(`✅ 成功解析 ${parsedData.length} 条记录`);
    return parsedData;
  }

  // 分割文本为独立记录
  splitIntoRecords(text) {
    // 首先尝试按空行分割（最常见的批量格式）
    let records = text.split(/\n\s*\n/).filter(r => r.trim());
    
    // 如果只有一条记录，检查是否为多字段格式（如包含Password Gmail:）
    if (records.length === 1 && text.includes('\n')) {
      // 检查是否为多字段格式（包含Password, 2fa等关键词）
      if (text.match(/Password\s+Gmail:|2fa\s+Gmail:/i)) {
        // 这是一个完整的多字段记录，不要分割
      } else {
        // 尝试按单行分割
        const lines = text.split('\n').filter(l => l.trim());
        // 检查是否每行都包含邮箱
        const linesWithEmail = lines.filter(l => l.includes('@'));
        if (linesWithEmail.length > 1) {
          records = lines;
        }
      }
    }
    
    // 其他分隔符
    if (records.length === 1) {
      const separators = [
        /---+/,           // 横线分隔
        /===+/,           // 等号分隔
        /\*\*\*+/,        // 星号分隔
        /；；+/,          // 中文分号
        /;;\s*;+/         // 多个分号
      ];
      
      for (const sep of separators) {
        const parts = records[0].split(sep);
        if (parts.length > 1) {
          records = parts;
          break;
        }
      }
    }
    
    // 过滤空记录和太短的记录
    return records
      .map(r => r.trim())
      .filter(r => r.length > 10 && r.includes('@'));
  }

  // 解析单条记录
  parseRecord(recordText, defaultAccountType) {
    // 首先尝试解析 --- 分隔的格式
    if (recordText.includes('---')) {
      const result = this.parseTripleDashFormat(recordText);
      if (result) {
        result.account_type = this.extractAccountType(recordText) || defaultAccountType;
        result.storage_date = this.extractDate(recordText);
        result.account_key = this.extractKey(recordText);
        return result;
      }
    }
    
    const lines = recordText.split(/\n/).map(l => l.trim()).filter(l => l);
    
    // 提取所有邮箱
    const emails = [];
    const emailMatches = recordText.match(this.emailRegex) || [];
    emails.push(...emailMatches);
    
    // 去重
    const uniqueEmails = [...new Set(emails)];
    
    if (uniqueEmails.length === 0) {
      return null;
    }
    
    // 智能识别主邮箱和辅助邮箱
    let mainEmail = '';
    let auxEmail = '';
    
    if (uniqueEmails.length === 1) {
      mainEmail = uniqueEmails[0];
    } else if (uniqueEmails.length >= 2) {
      // 第一个通常是主邮箱
      mainEmail = uniqueEmails[0];
      // 第二个是辅助邮箱
      auxEmail = uniqueEmails[1];
    }
    
    // 提取密码 - 改进版
    const mainPassword = this.extractPasswordImproved(recordText, mainEmail);
    const auxPassword = auxEmail ? this.extractPasswordImproved(recordText, auxEmail) : '';
    
    // 提取2FA密码
    const twoFACode = this.extract2FACode(recordText);
    
    
    // 提取账号类型
    const accountType = this.extractAccountType(recordText) || defaultAccountType;
    
    // 提取密钥
    const accountKey = this.extractKey(recordText);
    
    // 提取日期
    const storageDate = this.extractDate(recordText);
    
    return {
      account_type: accountType,
      email: mainEmail,
      email_password: mainPassword,
      auxiliary_email: auxEmail,
      auxiliary_email_password: auxPassword,
      two_fa_code: twoFACode,
      storage_date: storageDate,
      account_key: accountKey
    };
  }
  
  // 解析 --- 分隔格式
  parseTripleDashFormat(text) {
    // 分割文本，支持3个或更多连字符
    const parts = text.split(/---+/).map(p => p.trim());
    
    if (parts.length < 2) {
      return null;
    }
    
    // 清理密码中的特殊字符
    const cleanPassword = (pwd) => {
      if (!pwd) return '';
      // 移除末尾的特殊字符
      return pwd.replace(/[$*#!@~^&]+$/, '');
    };
    
    const result = {
      email: parts[0] || '',
      email_password: cleanPassword(parts[1] || ''),
      auxiliary_email: parts[2] || '',
      auxiliary_email_password: cleanPassword(parts[3] || ''),
      two_fa_code: parts[4] || ''
    };
    
    // 验证邮箱格式
    if (!result.email.includes('@')) {
      return null;
    }
    
    return result;
  }

  // 解析多邮箱共享密码格式
  parseSharedPasswordFormat(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    
    // 检查是否符合格式：多个邮箱 + 一个密码 + 可能的其他信息
    if (lines.length < 3) return null;
    
    // 提取所有邮箱
    const emails = [];
    let passwordLineIndex = -1;
    let password = '';
    
    // 查找邮箱行
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.match(/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/)) {
        emails.push(line);
      } else if (emails.length > 0 && passwordLineIndex === -1) {
        // 找到第一个非邮箱行，可能是密码
        // 检查是否像密码（包含字母和特殊字符）
        if (line.match(/^[a-zA-Z0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]+$/) && 
            line.length >= 6 && 
            line.match(/[a-zA-Z]/) && 
            (line.match(/[0-9]/) || line.match(/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/))) {
          password = line;
          passwordLineIndex = i;
          break;
        }
      }
    }
    
    // 如果找到了多个邮箱和一个密码，则认为是共享密码格式
    if (emails.length >= 2 && password) {
      const results = [];
      
      // 提取可能的附加信息（如 "us", "Turkey IP" 等）
      let additionalInfo = '';
      if (passwordLineIndex < lines.length - 1) {
        additionalInfo = lines.slice(passwordLineIndex + 1).join(' ');
      }
      
      // 为每个邮箱创建一条记录
      for (const email of emails) {
        const record = {
          account_type: '',
          email: email,
          email_password: password,
          auxiliary_email: '',
          auxiliary_email_password: '',
          two_fa_code: '',
          storage_date: '',
          account_key: ''
        };
        
        // 从附加信息中提取可能的账号类型或备注
        if (additionalInfo) {
          // 检查是否包含国家/地区信息
          if (additionalInfo.toLowerCase().includes('us') || 
              additionalInfo.toLowerCase().includes('uk') || 
              additionalInfo.toLowerCase().includes('germany') ||
              additionalInfo.toLowerCase().includes('ip')) {
            record.notes = additionalInfo;
          }
        }
        
        results.push(record);
      }
      
      return results;
    }
    
    return null;
  }

  // 解析混合聊天格式（包含时间戳和多种排列）
  parseMixedChatFormat(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    const results = [];
    
    console.log('🔍 混合聊天格式解析开始，处理行数:', lines.length);
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      console.log(`📝 处理行 ${i}: ${line}`);
      
      // 跳过纯时间戳行和描述行，但不跳过包含账号信息的行
      if ((line.match(/\[?\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}/) && !line.includes('@')) || 
          line.includes('google cloud') || 
          line.includes('got gcp') || 
          line.includes('Homie,') ||
          line.match(/^\d{2}:\d{2}$/)) {
        console.log('⏭️ 跳过时间戳或描述行');
        continue;
      }
      
      // 处理GCP格式: GCP: email:password 2fa:code
      if (line.startsWith('GCP:')) {
        console.log('🔍 检测到GCP格式');
        // 提取GCP后面的内容
        const gcpContent = line.substring(4).trim();
        
        // 匹配格式: email:password 2fa:code
        const gcpMatch = gcpContent.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}):([^\s]+)\s+2fa:(.+)/);
        if (gcpMatch) {
          const email = gcpMatch[1];
          const password = gcpMatch[2];
          const twoFA = gcpMatch[3].trim();
          
          results.push({
            account_type: 'GCP300',
            email: email,
            email_password: password,
            auxiliary_email: '',
            auxiliary_email_password: '',
            two_fa_code: twoFA,
            storage_date: this.getCurrentDate(),
            account_key: '',
            notes: `从GCP格式解析`
          });
          console.log(`✅ GCP账号解析: ${email} - ${password} - ${twoFA}`);
        }
        continue;
      }
      
      // 处理Telegram聊天复合格式: "GCp 300$: emailPassword amail: password Gmail: 2fa"
      // 支持前面带用户名和时间戳的情况: "UMAIR, [2025/8/24 12:53]Gcp 300$: email..."
      const telegramComplexMatch = line.match(/.*?GC[Pp]\s*300\$:\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})Password\s+amail:\s*([^\s]+)\s+Gmail:\s*([^:]+?)(?:fp?:\s*perú?)?$/i);
      if (telegramComplexMatch) {
        console.log('🔍 检测到Telegram复合格式');
        const email = telegramComplexMatch[1].trim();
        const password = telegramComplexMatch[2].trim();
        let twoFA = telegramComplexMatch[3].trim();
        
        // 清理2FA代码，移除可能的地区标识
        twoFA = twoFA.replace(/fp?:\s*perú?$/i, '').trim();
        
        results.push({
          account_type: 'GCP300',
          email: email,
          email_password: password,
          auxiliary_email: '',
          auxiliary_email_password: '',
          two_fa_code: twoFA,
          storage_date: this.getCurrentDate(),
          account_key: '',
          notes: `从Telegram复合格式解析`
        });
        console.log(`✅ Telegram复合格式账号解析: ${email} - ${password} - ${twoFA}`);
        continue;
      }
      
      // 处理Telegram聊天标准格式: "GCp 300$: emailPassword Gmail: password" + 下一行"2fa Gmail: code"
      const telegramStandardMatch = line.match(/GC[Pp]\s*300\$:\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})Password\s+Gmail:\s*(.+)/i);
      if (telegramStandardMatch) {
        console.log('🔍 检测到Telegram标准格式');
        const email = telegramStandardMatch[1].trim();
        const password = telegramStandardMatch[2].trim();
        let twoFA = '';
        
        // 检查下一行是否为2FA
        if (i + 1 < lines.length) {
          const nextLine = lines[i + 1];
          const twoFAMatch = nextLine.match(/2fa\s+Gmail:\s*(.+)/i);
          if (twoFAMatch) {
            twoFA = twoFAMatch[1].trim();
            i++; // 跳过2FA行
            console.log(`📱 找到2FA: ${twoFA}`);
          }
        }
        
        results.push({
          account_type: 'GCP300',
          email: email,
          email_password: password,
          auxiliary_email: '',
          auxiliary_email_password: '',
          two_fa_code: twoFA,
          storage_date: this.getCurrentDate(),
          account_key: '',
          notes: `从Telegram标准格式解析`
        });
        console.log(`✅ Telegram标准格式账号解析: ${email} - ${password} - ${twoFA}`);
        continue;
      }
      
      // 检查是否包含邮箱（可以在行内任意位置），如果是，检查下一行是否包含密码
      // 排除辅助邮箱行
      const emailMatch = line.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (emailMatch && i + 1 < lines.length && 
          !line.includes('辅助邮箱') && !line.includes('备用邮箱') && 
          !line.includes('auxiliary') && !line.includes('backup')) {
        const email = emailMatch[1];
        const nextLine = lines[i + 1];
        console.log(`📧 发现邮箱 ${email}，检查下一行: ${nextLine}`);
        
        // 跳过下一行是时间戳或描述的情况
        if (nextLine.match(/\[?\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}/) || 
            nextLine.includes('google cloud') || 
            nextLine.includes('got gcp') || 
            nextLine.includes('Homie,')) {
          console.log('⏭️ 下一行是时间戳或描述，跳过');
          continue;
        }
        
        // 解析密码行，支持包含@@符号和其他字符的复杂密码
        // 格式: password@@ukraine ip 或 password 其他信息
        let password = '';
        
        // 使用更智能的密码解析
        console.log(`🔐 分析密码行: ${nextLine}`);
        
        if (nextLine.includes('@@')) {
          // 包含@@符号的情况，需要特殊处理
          // 例如: Jegue245@@ukraine ip
          // 密码可能是: Jegue245@@ukraine
          const parts = nextLine.split(/\s+/);
          
          // 查找包含@@的部分
          for (let j = 0; j < parts.length; j++) {
            if (parts[j].includes('@@')) {
              // 找到@@部分，检查后面是否有国家或位置关键词
              const atPart = parts[j];
              const afterAt = atPart.split('@@')[1];
              
              // 如果@@后面的部分是位置关键词，则整个部分都是密码
              if (afterAt && this.isCountryOrLocationKeyword(afterAt)) {
                password = atPart; // 整个@@部分是密码: Jegue245@@ukraine
                console.log(`🔐 检测到@@+位置的密码: ${password}`);
                break;
              } else {
                // @@后面不是位置关键词，可能@@本身就是密码结尾
                password = atPart;
                console.log(`🔐 检测到@@密码: ${password}`);
                break;
              }
            }
          }
        } else {
          // 没有@@符号的普通情况
          const passwordTokens = nextLine.split(/\s+/).filter(t => t.length > 0);
          
          // 密码标识符列表
          const passwordIndicators = ['密码:', '密码：', 'password:', 'Password:', 'pass:', 'pwd:'];
          
          for (const token of passwordTokens) {
            // 跳过密码标识符
            if (passwordIndicators.includes(token)) {
              continue;
            }
            
            // 跳过国家名称等明显的非密码内容
            if (!this.isCountryOrLocationKeyword(token)) {
              password = token;
              console.log(`🔐 检测到普通密码: ${password}`);
              break;
            }
          }
        }
        
        if (password) {
          // 检查后续行是否有辅助邮箱
          let auxiliaryEmail = '';
          if (i + 2 < lines.length) {
            const thirdLine = lines[i + 2];
            if (thirdLine.includes('辅助邮箱') || thirdLine.includes('备用邮箱') || 
                thirdLine.includes('auxiliary') || thirdLine.includes('backup')) {
              const auxEmailMatch = thirdLine.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
              if (auxEmailMatch) {
                auxiliaryEmail = auxEmailMatch[1];
                console.log(`📧 发现辅助邮箱: ${auxiliaryEmail}`);
              }
            }
          }
          
          results.push({
            account_type: this.guessAccountType(email),
            email: email,
            email_password: password,
            auxiliary_email: auxiliaryEmail,
            auxiliary_email_password: '',
            two_fa_code: '',
            storage_date: this.getCurrentDate(),
            account_key: '',
            notes: `从多行格式解析 - 原始行: ${nextLine}`
          });
          console.log(`✅ 多行格式账号解析: ${email} - ${password}${auxiliaryEmail ? ` - 辅助邮箱: ${auxiliaryEmail}` : ''}`);
          i++; // 跳过已处理的密码行
          if (auxiliaryEmail) {
            i++; // 如果有辅助邮箱，也跳过辅助邮箱行
          }
          continue;
        }
      }
      
      // 处理简单聊天格式
      // 格式1: email: password
      let emailPasswordMatch = line.match(/^([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}):\s*(.+)$/);
      if (emailPasswordMatch) {
        const email = emailPasswordMatch[1];
        const password = emailPasswordMatch[2].trim();
        
        results.push({
          account_type: this.guessAccountType(email),
          email: email,
          email_password: password,
          auxiliary_email: '',
          auxiliary_email_password: '',
          two_fa_code: '',
          storage_date: this.getCurrentDate(),
          account_key: '',
          notes: `从聊天格式解析`
        });
        console.log(`✅ 简单格式账号解析: ${email} - ${password}`);
        continue;
      }
      
      // 格式2: 连续无空格格式 email直接连接password (如: email@gmail.comPassword123@@ukraine ip)
      const continuousMatch = line.match(/^([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(.+)$/);
      if (continuousMatch) {
        const email = continuousMatch[1];
        const afterEmail = continuousMatch[2];
        
        console.log(`🔍 检测到连续格式: 邮箱=${email}, 后续内容=${afterEmail}`);
        
        let password = '';
        
        if (afterEmail.includes('@@')) {
          // 包含@@的密码，例如: Password123@@ukraine ip
          const parts = afterEmail.split(/\s+/);
          for (const part of parts) {
            if (part.includes('@@')) {
              const atParts = part.split('@@');
              const afterAt = atParts[1];
              // 检查@@后面是否为位置关键词
              if (afterAt && this.isCountryOrLocationKeyword(afterAt)) {
                password = part; // 整个@@部分是密码
                console.log(`🔐 连续格式检测到@@+位置密码: ${password}`);
                break;
              } else {
                password = part;
                console.log(`🔐 连续格式检测到@@密码: ${password}`);
                break;
              }
            }
          }
        } else {
          // 没有@@的情况，找到第一个非位置关键词
          const parts = afterEmail.split(/\s+/).filter(p => p.length > 0);
          for (const part of parts) {
            if (!this.isCountryOrLocationKeyword(part)) {
              password = part;
              console.log(`🔐 连续格式检测到普通密码: ${password}`);
              break;
            }
          }
        }
        
        if (password) {
          results.push({
            account_type: this.guessAccountType(email),
            email: email,
            email_password: password,
            auxiliary_email: '',
            auxiliary_email_password: '',
            two_fa_code: '',
            storage_date: this.getCurrentDate(),
            account_key: '',
            notes: `从连续格式解析 - 原始: ${line}`
          });
          console.log(`✅ 连续格式账号解析: ${email} - ${password}`);
          continue;
        }
      }
      
      // 格式3: email password [2fa] (空格分隔)
      const tokens = line.split(/\s+/).filter(t => t.length > 0);
      if (tokens.length >= 2) {
        const emailMatch2 = tokens[0].match(/^([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})$/);
        if (emailMatch2) {
          const email = emailMatch2[1];
          const password = tokens[1];
          const twoFA = tokens.length > 2 ? tokens.slice(2).join(' ') : '';
          
          results.push({
            account_type: this.guessAccountType(email),
            email: email,
            email_password: password,
            auxiliary_email: '',
            auxiliary_email_password: '',
            two_fa_code: twoFA,
            storage_date: this.getCurrentDate(),
            account_key: '',
            notes: `从聊天格式解析`
          });
          console.log(`✅ 空格分隔格式账号解析: ${email} - ${password} - ${twoFA}`);
          continue;
        }
      }
    }
    
    console.log(`🔍 混合聊天格式解析完成，共解析 ${results.length} 个账号`);
    return results.length > 0 ? results : null;
  }

  // 提取密码
  extractPassword(text, email) {
    // 先尝试查找"Password Gmail:"格式
    const passwordMatch = text.match(/Password\s+Gmail[:\s]+([^\n]+)/i);
    if (passwordMatch) {
      return passwordMatch[1].trim();
    }
    
    // 查找邮箱附近的密码
    const emailIndex = text.indexOf(email);
    if (emailIndex === -1) return '';
    
    // 获取邮箱后面的文本
    const after = text.substring(emailIndex + email.length, Math.min(text.length, emailIndex + email.length + 100));
    
    // 多种密码提取模式
    const patterns = [
      /^密码是([^\s\n,;，；]+)/,       // 密码是xxx
      /^[：:\s\|,，-]*([^\s\n,;，；\|@辅助备用]+)/, // 直接跟在邮箱后的密码
      /密码[：:]\s*([^\s\n,;，；]+)/,  // 密码：xxx
    ];
    
    for (const pattern of patterns) {
      const match = after.match(pattern);
      if (match && match[1]) {
        const candidate = match[1].trim();
        // 过滤掉明显不是密码的内容
        if (candidate.length >= 3 && 
            !candidate.includes('@') && 
            !candidate.includes('邮箱') &&
            !candidate.includes('辅助') &&
            !candidate.includes('备用')) {
          return candidate;
        }
      }
    }
    
    return '';
  }

  // 提取账号类型
  extractAccountType(text) {
    const typePatterns = [
      { pattern: /gmail/i, type: 'Gmail' },
      { pattern: /outlook|hotmail/i, type: 'Outlook' },
      { pattern: /yahoo/i, type: 'Yahoo' },
      { pattern: /apple|icloud/i, type: 'Apple ID' },
      { pattern: /qq邮箱/i, type: 'QQ邮箱' },
      { pattern: /163|网易/i, type: '网易邮箱' },
      { pattern: /账号类型[：:]\s*([^\n,，]+)/i, type: null }
    ];
    
    for (const { pattern, type } of typePatterns) {
      const match = text.match(pattern);
      if (match) {
        return type || match[1].trim();
      }
    }
    
    return '';
  }

  // 提取密钥
  extractKey(text) {
    // 先检查传统密钥格式
    const keyPatterns = [
      /密钥[：:]\s*([^\n,，]+)/i,
      /key[：:]\s*([^\n,，]+)/i,
      /激活码[：:]\s*([^\n,，]+)/i,
      /序列号[：:]\s*([^\n,，]+)/i
    ];
    
    for (const pattern of keyPatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        const key = match[1].trim();
        if (key && key !== '无' && key !== 'none' && key !== 'null') {
          return key;
        }
      }
    }
    
    // 检查 API Key 格式（AIzaSy开头的字符串）
    const apiKeys = this.extractAPIKeys(text);
    if (apiKeys.length > 0) {
      return apiKeys.join(','); // 多个key用逗号分隔
    }
    
    return '';
  }
  
  // 提取API密钥（AIzaSy开头）
  extractAPIKeys(text) {
    const apiKeyPattern = /AIzaSy[A-Za-z0-9_-]{33}/g;
    const keys = [];
    let match;
    
    while ((match = apiKeyPattern.exec(text)) !== null) {
      keys.push(match[0]);
    }
    
    return keys;
  }

  // 提取日期
  extractDate(text) {
    // 日期格式
    const datePatterns = [
      /(\d{4}[-/]\d{1,2}[-/]\d{1,2})/,
      /(\d{1,2}[-/]\d{1,2}[-/]\d{4})/,
      /(今天|今日|现在|当前)/i
    ];
    
    for (const pattern of datePatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        const dateStr = match[1];
        if (dateStr.match(/今天|今日|现在|当前/)) {
          return '现在';
        }
        return dateStr;
      }
    }
    
    return '现在';
  }

  // 改进的密码提取方法
  extractPasswordImproved(text, email) {
    // 先尝试用原方法
    let password = this.extractPassword(text, email);
    if (password) return password;
    
    // 如果原方法失败，尝试更灵活的提取
    const emailIndex = text.indexOf(email);
    if (emailIndex === -1) return '';
    
    // 获取邮箱后面的内容
    const afterEmail = text.substring(emailIndex + email.length);
    
    // 分割成单词/token
    const tokens = afterEmail.split(/[\s,;，；\|\n]+/).filter(t => t.length > 0);
    
    // 查找第一个看起来像密码的token
    for (const token of tokens) {
      // 跳过包含@的（可能是另一个邮箱）
      if (token.includes('@')) continue;
      
      // 跳过太短的
      if (token.length < 4) continue;
      
      // 跳过中文关键词
      if (/^(辅助|备用|邮箱|密码|账号|类型|时间|密钥)/.test(token)) continue;
      
      // 如果是第二个邮箱，检查是否是"lv"这样的特殊标记
      if (email === tokens[0] && token === 'lv') continue;
      
      // 这个token很可能是密码
      return token;
    }
    
    return '';
  }

  // 判断是否为常见词汇（非密码）
  isCommonWord(word) {
    const commonWords = [
      'gmail', 'outlook', 'hotmail', 'yahoo', 'com', 'cn', 'net',
      '邮箱', '账号', '用户', 'email', 'mail', 'user', 'account'
    ];
    
    const lowerWord = word.toLowerCase();
    return commonWords.some(w => lowerWord.includes(w));
  }

  // 提取2FA密码
  extract2FACode(text) {
    // 先尝试特定格式 "2fa Gmail: xxxx"
    const specificMatch = text.match(/2fa\s+Gmail[:\s]+([^\n]+)/i);
    if (specificMatch) {
      return specificMatch[1].trim();
    }
    
    // 查找2FA相关标识
    for (const indicator of this.twoFAIndicators) {
      const regex = new RegExp(`${indicator}[\\s:：]+([\\w\\s]+)`, 'i');
      const match = text.match(regex);
      if (match) {
        // 提取2FA码，可能是多个单词组成
        let code = match[1].trim();
        // 限制长度，避免提取到过多内容
        const words = code.split(/\s+/);
        if (words.length > 8) {
          // 通常2FA恢复码是8组
          code = words.slice(0, 8).join(' ');
        }
        return code;
      }
    }
    
    // 特殊格式：查找连续的由空格分隔的短字符串（如：5q5y hto2 ksnz）
    const pattern = /(?:^|\n)([a-z0-9]{4}(?:\s+[a-z0-9]{4}){3,7})(?:$|\n)/i;
    const match = text.match(pattern);
    if (match) {
      return match[1].trim();
    }
    
    // 检查32位连续字符串（通常是TOTP密钥）
    const totpPattern = /(?:^|\n)([a-z0-9]{32})(?:$|\n)/i;
    const totpMatch = text.match(totpPattern);
    if (totpMatch) {
      // 确保这不是邮箱或密码的一部分
      const candidate = totpMatch[1];
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === candidate) {
          // 检查前后行是否包含邮箱或密码
          const prevLine = i > 0 ? lines[i-1].trim() : '';
          const nextLine = i < lines.length - 1 ? lines[i+1].trim() : '';
          
          // 如果前一行包含邮箱，后一行不包含邮箱，则认为是2FA密钥
          if (prevLine.includes('@') || (i > 1 && lines[i-2].trim().includes('@'))) {
            return candidate;
          }
        }
      }
    }
    
    return '';
  }

  // 转换为CSV格式
  toCSV(parsedData) {
    const headers = ['账号类型', '邮箱', '邮箱密码', '2FA密码', '辅助邮箱', '辅助邮箱密码', '入库时间', '账号密钥'];
    const rows = [headers.join(',')];
    
    for (const record of parsedData) {
      const row = [
        record.account_type || '',
        record.email || '',
        record.email_password || '',
        record.two_fa_code || '',
        record.auxiliary_email || '',
        record.auxiliary_email_password || '',
        record.storage_date || '',
        record.account_key || ''
      ];
      rows.push(row.join(','));
    }
    
    return rows.join('\n');
  }

  // 生成预览（隐藏密码）
  generatePreview(parsedData, maxRows = 5) {
    let preview = '📋 解析结果预览\n\n';
    const displayData = parsedData.slice(0, maxRows);
    
    displayData.forEach((record, index) => {
      preview += `【第 ${index + 1} 条】\n`;
      preview += `账号类型：${record.account_type || '未指定'}\n`;
      preview += `邮箱：${record.email || '无'}\n`;
      preview += `邮箱密码：${record.email_password ? '*'.repeat(8) : '无'}\n`;
      preview += `辅助邮箱：${record.auxiliary_email || '无'}\n`;
      preview += `辅助密码：${record.auxiliary_email_password ? '*'.repeat(8) : '无'}\n`;
      preview += `入库时间：${record.storage_date || '无'}\n`;
      preview += `账号密钥：${record.account_key || '无'}\n`;
      preview += '─'.repeat(30) + '\n';
    });
    
    if (parsedData.length > maxRows) {
      preview += `\n... 还有 ${parsedData.length - maxRows} 条数据`;
    }
    
    return preview;
  }
  
  // 获取当前日期
  getCurrentDate() {
    return new Date().toISOString().split('T')[0];
  }

  // 检查是否为国家或地区关键词
  isCountryOrLocationKeyword(token) {
    const countries = [
      'ukraine', 'ip', 'usa', 'china', 'japan', 'korea', 'india', 'russia',
      'germany', 'france', 'uk', 'canada', 'australia', 'brazil', 'mexico',
      'spain', 'italy', 'turkey', 'poland', 'netherlands', 'belgium',
      'sweden', 'norway', 'finland', 'denmark', 'switzerland', 'austria',
      'portugal', 'greece', 'czech', 'hungary', 'romania', 'bulgaria',
      'croatia', 'serbia', 'slovakia', 'slovenia', 'estonia', 'latvia',
      'lithuania', 'belarus', 'moldova', 'armenia', 'georgia', 'azerbaijan',
      'kazakhstan', 'uzbekistan', 'kyrgyzstan', 'tajikistan', 'turkmenistan',
      'afghanistan', 'pakistan', 'bangladesh', 'sri lanka', 'nepal', 'bhutan',
      'maldives', 'thailand', 'vietnam', 'cambodia', 'laos', 'myanmar',
      'malaysia', 'singapore', 'indonesia', 'philippines', 'brunei',
      'mongolia', 'north korea', 'south korea', 'taiwan', 'hong kong',
      'macau', 'tibet', 'xinjiang', 'inner mongolia', 'peru', 'perú'
    ];
    
    return countries.includes(token.toLowerCase()) || 
           token.toLowerCase() === 'ip' || 
           token.toLowerCase().includes('国') ||
           token.toLowerCase().includes('省') ||
           token.toLowerCase().includes('市');
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
  
  // 检测是否看起来像临时邮箱
  looksLikeTemporaryEmail(email) {
    const tempDomains = [
      'tmpmail.org', 'teml.net', 'moakt.cc', 'guerrillamail.com', 
      '10minutemail.com', 'mailinator.com', 'temp-mail.org', 
      'throwaway.email', 'getnada.com', 'maildrop.cc',
      'tmpbox.net', 'tempr.email', 'yopmail.com'
    ];
    
    const domain = email.toLowerCase().split('@')[1];
    return tempDomains.some(tempDomain => domain && domain.includes(tempDomain));
  }
  
  // 检测是否为三行一组格式（增强版，支持混合格式）
  isThreeLineFormat(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    
    // 必须至少有3行
    if (lines.length < 3) return false;
    
    // 排除包含2FA标识的格式（这些应该用传统解析器处理）
    const textLower = text.toLowerCase();
    if (textLower.includes('2fa:') || textLower.includes('totp:') || 
        textLower.includes('两步验证') || textLower.includes('验证码')) {
      console.log('🔍 检测到2FA标识，不使用三行一组解析');
      return false;
    }
    
    // 统计可能的三行一组群组
    let threeLineGroups = 0;
    let i = 0;
    
    while (i < lines.length) {
      // 检查是否为三行一组格式：邮箱 -> 密码 -> 邮箱
      // 增加额外条件：第三行应该是临时邮箱（包含常见的临时邮箱域名）
      if (i + 2 < lines.length && 
          this.emailRegex.test(lines[i]) && 
          !this.emailRegex.test(lines[i + 1]) && 
          this.emailRegex.test(lines[i + 2]) &&
          this.looksLikeTemporaryEmail(lines[i + 2])) {
        
        threeLineGroups++;
        i += 3; // 跳过3行
        console.log(`🔍 发现三行一组群组 ${threeLineGroups}：${lines[i-3]} -> ${lines[i-2].substring(0, 3)}*** -> ${lines[i-1]}`);
      } else {
        i++; // 继续检查下一行
      }
    }
    
    // 如果发现至少2个三行一组群组，认为这是混合格式，使用增强解析器
    if (threeLineGroups >= 2) {
      console.log(`🔍 检测到 ${threeLineGroups} 个三行一组群组，使用混合格式解析`);
      return true;
    }
    
    console.log(`🔍 只发现 ${threeLineGroups} 个三行一组群组，不够使用三行格式解析`);
    return false;
  }

  // 解析三行一组格式（增强版，支持混合格式）
  parseThreeLineFormat(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const accounts = [];
    let groupCount = 0;
    
    console.log('📋 开始解析混合格式（包含三行一组）...');
    console.log('📝 总行数:', lines.length);
    
    let i = 0;
    while (i < lines.length) {
      // 检查是否为三行一组格式：邮箱 -> 密码 -> 临时邮箱
      if (i + 2 < lines.length && 
          this.emailRegex.test(lines[i]) && 
          !this.emailRegex.test(lines[i + 1]) && 
          this.emailRegex.test(lines[i + 2]) &&
          this.looksLikeTemporaryEmail(lines[i + 2])) {
        
        // 发现三行一组格式
        groupCount++;
        const email = lines[i].trim();
        const password = lines[i + 1].trim(); 
        const tempEmail = lines[i + 2].trim();
        
        console.log(`📧 解析三行一组第${groupCount}组:`);
        console.log(`  邮箱: ${email}`);
        console.log(`  密码: ${password.substring(0, 3)}***`);
        console.log(`  辅助邮箱: ${tempEmail}`);
        
        const account = {
          account_type: '', // 账号类型由提交者选择
          email: email,
          email_password: password,
          auxiliary_email: tempEmail,
          auxiliary_email_password: '',
          two_fa_code: '',
          storage_date: this.getCurrentDate(),
          account_key: '',
          notes: `三行一组格式解析 - 组${groupCount}`
        };
        
        accounts.push(account);
        console.log(`✅ 三行一组解析成功: ${email}`);
        i += 3; // 跳过3行
        
      } else if (i + 1 < lines.length && 
                 this.emailRegex.test(lines[i]) && 
                 !this.emailRegex.test(lines[i + 1])) {
        
        // 发现两行格式：邮箱 -> 密码
        groupCount++;
        const email = lines[i].trim();
        const password = lines[i + 1].trim();
        
        console.log(`📧 解析两行格式第${groupCount}组:`);
        console.log(`  邮箱: ${email}`);
        console.log(`  密码: ${password.substring(0, 3)}***`);
        
        const account = {
          account_type: '', // 账号类型由提交者选择
          email: email,
          email_password: password,
          auxiliary_email: '',
          auxiliary_email_password: '',
          two_fa_code: '',
          storage_date: this.getCurrentDate(),
          account_key: '',
          notes: `两行格式解析 - 组${groupCount}`
        };
        
        accounts.push(account);
        console.log(`✅ 两行格式解析成功: ${email}`);
        i += 2; // 跳过2行
        
      } else {
        // 无法识别的格式，跳到下一行
        console.log(`⚠️ 跳过无法识别的行: ${lines[i]}`);
        i++;
      }
    }
    
    console.log(`🎉 混合格式解析完成，共解析 ${accounts.length} 个账号`);
    return accounts;
  }

  // 检测是否为CSV格式
  isCSVFormat(text) {
    const lines = text.trim().split('\n');
    
    // 情况1：标准CSV格式（头部+数据行）
    if (lines.length >= 2) {
      const firstLine = lines[0].toLowerCase();
      const csvHeaders = ['email', 'password', 'totp', 'backup_email', 'cpny'];
      const hasEmailHeader = csvHeaders.some(header => firstLine.includes(header));
      
      // 检查是否有逗号分隔
      const hasCommas = lines[0].includes(',') && lines[1].includes(',');
      
      // 检查数据行格式
      const dataLine = lines[1];
      const fields = dataLine.split(',');
      const hasEmail = fields.some(field => this.emailRegex.test(field.trim()));
      
      if (hasEmailHeader && hasCommas && hasEmail && fields.length >= 3) {
        return true;
      }
    }
    
    // 情况2：单行CSV数据格式（无头部，直接是数据）
    if (lines.length === 1) {
      const line = lines[0];
      // 必须包含逗号分隔符
      if (!line.includes(',')) return false;
      
      const fields = line.split(',').map(f => f.trim());
      // 至少3个字段
      if (fields.length < 3) return false;
      
      // 第一个字段必须是邮箱
      if (!this.emailRegex.test(fields[0])) return false;
      
      // 第二个字段应该是密码（长度合理）
      if (!fields[1] || fields[1].length < 3) return false;
      
      // 这种格式通常是: email,password,totp,aux_email,other
      console.log('📍 检测到单行CSV数据格式');
      return true;
    }
    
    return false;
  }
  
  // 解析CSV格式数据
  parseCSVFormat(text) {
    const lines = text.trim().split('\n');
    const results = [];
    
    if (lines.length === 0) return results;
    
    // 情况1：单行CSV数据（无头部）
    if (lines.length === 1) {
      console.log('📋 解析单行CSV数据');
      const fields = lines[0].split(',').map(f => f.trim());
      console.log('📝 字段:', fields);
      
      // 默认字段顺序: email, password, totp, backup_email, other...
      const email = fields[0] || '';
      const password = fields[1] || '';
      const totp = fields[2] || '';
      const backupEmail = fields[3] || '';
      
      if (email && this.emailRegex.test(email)) {
        // 🔍 检测字段4及之后的API Keys (AIzaSy开头的39字符字符串)
        const apiKeys = [];
        for (let i = 4; i < fields.length; i++) {
          const field = fields[i].trim();
          if (field && /^AIzaSy[A-Za-z0-9_-]{33}$/.test(field)) {
            apiKeys.push(field);
            console.log('🔑 发现API Key:', field);
          }
        }
        
        const account = {
          account_type: this.guessAccountType(email),
          email: email,
          email_password: password,
          auxiliary_email: backupEmail,
          auxiliary_email_password: '',
          two_fa_code: totp,
          storage_date: this.getCurrentDate(),
          account_key: apiKeys.join(','),  // 将API Keys用逗号连接
          notes: `单行CSV导入: ${lines[0]}`
        };
        
        results.push(account);
        console.log('✅ 解析单行CSV账号:', { 
          email, 
          password: password ? '***' : '', 
          totp: totp ? '***' : '',
          apiKeys: apiKeys.length > 0 ? `${apiKeys.length}个API Key` : '无'
        });
      }
      
      // 🔍 只有在检测到真正的混合格式时才查找额外邮箱（避免把backup_email当作新账号）
      // 标准CSV格式 (email,password,totp,backup_email) 不应该触发额外邮箱检测
      const isStandardCSV = fields.length >= 4 && 
                          this.emailRegex.test(fields[0]) && 
                          fields[1] && 
                          this.emailRegex.test(fields[3]);
      
      if (!isStandardCSV) {
        console.log('🔍 非标准CSV格式，检查混合数据中的额外邮箱...');
        const allFieldsText = fields.join(' ');
        const additionalEmails = this.findAllEmails(allFieldsText);
        
        for (const additionalEmail of additionalEmails) {
          if (additionalEmail !== email && additionalEmail !== backupEmail) {
            console.log('🔍 发现字段内的额外邮箱:', additionalEmail);
            
            // 找到这个邮箱在fields中的位置，推断相关字段
            const emailFieldIndex = fields.findIndex(f => f.includes(additionalEmail));
            if (emailFieldIndex >= 0) {
              // 尝试从邮箱后面的字段推断密码，跳过无效数据
              let potentialPassword = emailFieldIndex + 1 < fields.length ? fields[emailFieldIndex + 1] : '';
              let potentialTotp = emailFieldIndex + 2 < fields.length ? fields[emailFieldIndex + 2] : '';
              
              // 过滤无效数据
              if (this.isInvalidData(potentialPassword)) {
                console.log('🚫 跳过无效密码数据:', potentialPassword);
                potentialPassword = '';
              }
              if (this.isInvalidData(potentialTotp)) {
                console.log('🚫 跳过无效2FA数据:', potentialTotp);
                potentialTotp = '';
              }
              
              const additionalAccount = {
                account_type: this.guessAccountType(additionalEmail),
                email: additionalEmail,
                email_password: potentialPassword,
                auxiliary_email: '',
                auxiliary_email_password: '',
                two_fa_code: potentialTotp,
                storage_date: this.getCurrentDate(),
                account_key: '',
                notes: `单行CSV混合数据解析: ${additionalEmail} 来自字段 ${emailFieldIndex}`
              };
              
              results.push(additionalAccount);
              console.log('✅ 解析混合数据中的账号:', { 
                email: additionalEmail, 
                password: potentialPassword ? '***' : '', 
                totp: potentialTotp ? '***' : '',
                fromField: emailFieldIndex 
              });
            }
          }
        }
      } else {
        console.log('📋 标准CSV格式，跳过额外邮箱检测');
      }
      
      return results;
    }
    
    // 情况2：标准CSV格式（头部+数据行）
    if (lines.length < 2) return results;
    
    // 解析头部
    const headers = lines[0].toLowerCase().split(',').map(h => h.trim());
    console.log('📋 CSV头部:', headers);
    
    // 找到列索引
    const emailIndex = this.findHeaderIndex(headers, ['email']);
    const passwordIndex = this.findHeaderIndex(headers, ['password']);
    const totpIndex = this.findHeaderIndex(headers, ['totp', '2fa', 'two_fa']);
    const backupEmailIndex = this.findHeaderIndex(headers, ['backup_email', 'auxiliary_email', 'aux_email']);
    const backupPasswordIndex = this.findHeaderIndex(headers, ['backup_password', 'aux_password']);
    
    console.log('📍 列索引映射:', {
      email: emailIndex,
      password: passwordIndex,
      totp: totpIndex,
      backupEmail: backupEmailIndex,
      backupPassword: backupPasswordIndex
    });
    
    // 解析数据行
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      const fields = line.split(',').map(f => f.trim());
      console.log(`📝 处理第${i}行:`, fields);
      
      const email = emailIndex >= 0 ? fields[emailIndex] : '';
      const password = passwordIndex >= 0 ? fields[passwordIndex] : '';
      let totp = totpIndex >= 0 ? fields[totpIndex] : '';
      const backupEmail = backupEmailIndex >= 0 ? fields[backupEmailIndex] : '';
      const backupPassword = backupPasswordIndex >= 0 ? fields[backupPasswordIndex] : '';
      
      // 🔍 检测多列API Keys (api_key_1, api_key_2, api_key_3等)
      const apiKeys = [];
      for (let j = 0; j < headers.length; j++) {
        const header = headers[j];
        if (header.includes('api_key') && j < fields.length) {
          const field = fields[j].trim();
          if (field && /^AIzaSy[A-Za-z0-9_-]{33}$/.test(field)) {
            apiKeys.push(field);
            console.log(`🔑 发现API Key (${header}):`, field);
          }
        }
      }
      
      // 🔍 智能识别2FA密码（可能在其他字段中，如profile_id）
      if (!totp) {
        for (let j = 0; j < fields.length; j++) {
          const field = fields[j].trim();
          const header = headers[j] || '';
          
          // 检查是否为2FA格式（6-8位字母数字组合）
          // 但要排除明显的业务数据字段
          if (field && 
              /^[a-zA-Z0-9]{6,8}$/.test(field) && 
              !this.emailRegex.test(field) && 
              !field.includes('-') && 
              !field.includes('独享') && 
              !field.includes('成功') && 
              header !== 'status' &&
              header !== 'reason' &&
              header !== 'billing_status' &&
              header !== 'billing_id' &&
              header !== 'profile_id' &&  // profile_id不应该被识别为2FA
              header !== 'account_idx' &&
              header !== 'cpny' &&
              !header.includes('id') &&  // 所有ID类字段都要排除
              !field.startsWith('01') &&  // 01开头的是ID，不是2FA
              !field.startsWith('k13')    // k13开头的是业务数据，不是2FA
          ) {
            totp = field;
            console.log(`🔍 在字段 ${header} 中发现可能的2FA码:`, field);
            break;
          }
        }
      }
      
      if (email && this.emailRegex.test(email)) {
        const account = {
          account_type: this.guessAccountType(email),
          email: email,
          email_password: password,
          auxiliary_email: backupEmail,
          auxiliary_email_password: backupPassword,
          two_fa_code: totp,
          storage_date: this.getCurrentDate(),
          account_key: apiKeys.join(','), // 多个API Keys用逗号连接
          notes: `CSV导入: ${line}`
        };
        
        results.push(account);
        console.log('✅ 解析CSV账号:', { 
          email, 
          password: password ? '***' : '', 
          totp: totp ? '***' : '',
          apiKeys: apiKeys.length > 0 ? `${apiKeys.length}个API Key` : '无'
        });
      } else {
        console.log('❌ 跳过无效行:', { email, 'email正则测试': email ? this.emailRegex.test(email) : false });
      }
      
      // 🔍 只在非标准CSV格式时才检查额外邮箱（避免backup_email被误识别为独立账号）
      // 标准多列CSV格式不应该触发额外邮箱检测
      const isMultiColumnCSV = headers.length >= 5 && 
                            headers.includes('email') && 
                            (headers.includes('backup_email') || headers.includes('auxiliary_email'));
      
      if (!isMultiColumnCSV) {
        console.log('🔍 非标准多列CSV格式，检查混合数据中的额外邮箱...');
        const allFieldsText = fields.join(' ');
        const additionalEmails = this.findAllEmails(allFieldsText);
        
        for (const additionalEmail of additionalEmails) {
          if (additionalEmail !== email && additionalEmail !== backupEmail && additionalEmail) {
            console.log('🔍 发现字段内的额外邮箱:', additionalEmail);
            
            // 找到这个邮箱在fields中的位置，推断相关字段
            const emailFieldIndex = fields.findIndex(f => f.includes(additionalEmail));
            if (emailFieldIndex >= 0) {
              // 尝试从邮箱后面的字段推断密码，跳过无效数据
              let potentialPassword = emailFieldIndex + 1 < fields.length ? fields[emailFieldIndex + 1] : '';
              let potentialTotp = emailFieldIndex + 2 < fields.length ? fields[emailFieldIndex + 2] : '';
              
              // 过滤无效数据
              if (this.isInvalidData(potentialPassword)) {
                console.log('🚫 跳过无效密码数据:', potentialPassword);
                potentialPassword = '';
              }
              if (this.isInvalidData(potentialTotp)) {
                console.log('🚫 跳过无效2FA数据:', potentialTotp);
                potentialTotp = '';
              }
              
              const additionalAccount = {
                account_type: this.guessAccountType(additionalEmail),
                email: additionalEmail,
                email_password: potentialPassword,
                auxiliary_email: '',
                auxiliary_email_password: '',
                two_fa_code: potentialTotp,
                storage_date: this.getCurrentDate(),
                account_key: '',
                notes: `CSV混合数据解析: ${additionalEmail} 来自字段 ${emailFieldIndex}`
              };
              
              results.push(additionalAccount);
              console.log('✅ 解析混合数据中的账号:', { 
                email: additionalEmail, 
                password: potentialPassword ? '***' : '', 
                totp: potentialTotp ? '***' : '',
                fromField: emailFieldIndex 
              });
            }
          }
        }
      } else {
        console.log('📋 标准多列CSV格式，跳过额外邮箱检测');
      }
    }
    
    return results;
  }
  
  // 查找文本中所有邮箱地址
  findAllEmails(text) {
    const emails = [];
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    let match;
    
    while ((match = emailRegex.exec(text)) !== null) {
      emails.push(match[0]);
    }
    
    return emails;
  }
  
  // 检查是否为无效数据
  isInvalidData(data) {
    if (!data || data.trim() === '') return true;
    
    const invalidPatterns = [
      'k12a0dn7',           // 已知的无效数据
      /^[a-z0-9]{8}$/,      // 8位随机字符串
      /^[0-9]{1,3}$/,       // 1-3位纯数字
      /^[a-z]{1,3}$/,       // 1-3位纯字母（可能是国家代码）
      /^\.+$/,              // 只有点号
      /^,+$/,               // 只有逗号
    ];
    
    for (const pattern of invalidPatterns) {
      if (typeof pattern === 'string' && data === pattern) {
        return true;
      }
      if (pattern instanceof RegExp && pattern.test(data)) {
        return true;
      }
    }
    
    return false;
  }
  
  // 查找头部索引的辅助方法
  findHeaderIndex(headers, candidates) {
    for (let i = 0; i < headers.length; i++) {
      for (const candidate of candidates) {
        if (headers[i].includes(candidate)) {
          return i;
        }
      }
    }
    return -1;
  }
  
  // 检测是否为"账号行+API Key行"格式
  isAccountWithAPIKeysFormat(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    
    // 至少需要2行：账号行 + API Key行
    if (lines.length < 2) return false;
    
    // 第一行应该包含邮箱和其他账号信息（空格分隔）
    const firstLine = lines[0];
    const firstLineTokens = firstLine.split(/\s+/).filter(t => t.length > 0);
    
    // 第一行必须包含邮箱，且有多个字段
    const hasEmail = firstLineTokens.some(token => this.emailRegex.test(token));
    if (!hasEmail || firstLineTokens.length < 2) return false;
    
    // 检查后续行是否都是API Key格式
    let apiKeyCount = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      // 检查这一行是否只包含API Key（可能有多个，空格分隔）
      const tokens = line.split(/\s+/).filter(t => t.length > 0);
      const allTokensAreAPIKeys = tokens.length > 0 && tokens.every(token => /^AIzaSy[A-Za-z0-9_-]{33}$/.test(token));
      
      if (allTokensAreAPIKeys) {
        apiKeyCount++;
      } else {
        // 如果遇到非API Key行，则不是这种格式
        return false;
      }
    }
    
    // 至少有一行API Key
    if (apiKeyCount >= 1) {
      console.log(`🔍 检测到账号行+API Key行格式：第一行有账号信息，后续${apiKeyCount}行为API Key`);
      return true;
    }
    
    return false;
  }
  
  // 解析"账号行+API Key行"格式
  parseAccountWithAPIKeysFormat(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    console.log('📋 解析账号行+API Key行格式...');
    
    if (lines.length < 2) return null;
    
    // 解析第一行的账号信息
    const accountLine = lines[0];
    console.log('📝 账号行:', accountLine);
    
    // 使用SimpleAccountParser解析账号行
    const accountResult = this.simpleParser.parseSimpleFormat(accountLine);
    if (!accountResult || accountResult.length === 0) {
      console.log('❌ 账号行解析失败');
      return null;
    }
    
    // 收集后续所有API Key行
    const allAPIKeys = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const tokens = line.split(/\s+/).filter(t => t.length > 0);
      
      for (const token of tokens) {
        if (/^AIzaSy[A-Za-z0-9_-]{33}$/.test(token)) {
          allAPIKeys.push(token);
        }
      }
    }
    
    console.log('🔑 找到的API Keys:', allAPIKeys);
    
    // 将API Key关联到解析出的账号
    if (allAPIKeys.length > 0 && accountResult.length > 0) {
      // 将所有API Key关联到第一个账号（通常只有一个账号）
      accountResult[0].account_key = allAPIKeys.join(',');
      console.log('✅ API Key已关联到账号:', accountResult[0].email);
    }
    
    return accountResult;
  }
  
  // 检测是否为"CSV行+API Key行"格式
  isCSVWithAPIKeysFormat(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    
    // 需要至少2行数据
    if (lines.length < 2) return false;
    
    // 智能分组：寻找CSV行后跟着的API Key行模式
    const groups = [];
    let i = 0;
    
    while (i < lines.length) {
      const line = lines[i];
      
      // 如果当前行是CSV格式（包含逗号和邮箱）
      if (line.includes(',') && this.emailRegex.test(line)) {
        const group = [line];
        let j = i + 1;
        
        // 收集后续的API Key行
        while (j < lines.length) {
          const nextLine = lines[j];
          
          // 如果下一行是API Key
          const tokens = nextLine.split(/\s+/).filter(t => t.length > 0);
          const isAPIKeyLine = tokens.length > 0 && tokens.every(token => /^AIzaSy[A-Za-z0-9_-]{33}$/.test(token));
          
          if (isAPIKeyLine) {
            group.push(nextLine);
            j++;
          } else if (nextLine.includes(',') && this.emailRegex.test(nextLine)) {
            // 如果遇到另一个CSV行，则当前组结束，下个组开始
            break;
          } else {
            // 遇到其他格式的行，当前组结束
            break;
          }
        }
        
        if (group.length >= 2) { // 至少有CSV行 + 一个API Key行
          groups.push(group);
        }
        
        i = j; // 跳转到下一个未处理的行
      } else {
        i++; // 跳过非CSV行
      }
    }
    
    if (groups.length > 0) {
      console.log(`🔍 检测到CSV行+API Key行格式：${groups.length}组CSV账号+API Key数据`);
      return true;
    }
    
    return false;
  }
  
  // 解析"CSV行+API Key行"格式
  parseCSVWithAPIKeysFormat(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    console.log('📋 解析CSV行+API Key行格式...');
    
    // 使用与检测相同的智能分组逻辑
    const groups = [];
    let i = 0;
    
    while (i < lines.length) {
      const line = lines[i];
      
      // 如果当前行是CSV格式（包含逗号和邮箱）
      if (line.includes(',') && this.emailRegex.test(line)) {
        const group = [line];
        let j = i + 1;
        
        // 收集后续的API Key行
        while (j < lines.length) {
          const nextLine = lines[j];
          
          // 如果下一行是API Key
          const tokens = nextLine.split(/\s+/).filter(t => t.length > 0);
          const isAPIKeyLine = tokens.length > 0 && tokens.every(token => /^AIzaSy[A-Za-z0-9_-]{33}$/.test(token));
          
          if (isAPIKeyLine) {
            group.push(nextLine);
            j++;
          } else if (nextLine.includes(',') && this.emailRegex.test(nextLine)) {
            // 如果遇到另一个CSV行，则当前组结束，下个组开始
            break;
          } else {
            // 遇到其他格式的行，当前组结束
            break;
          }
        }
        
        if (group.length >= 2) { // 至少有CSV行 + 一个API Key行
          groups.push(group);
        }
        
        i = j; // 跳转到下一个未处理的行
      } else {
        i++; // 跳过非CSV行
      }
    }
    
    const accounts = [];
    
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (group.length >= 2) {
        const csvLine = group[0];
        const apiLines = group.slice(1);
        
        console.log(`📝 处理第${i + 1}组: CSV行="${csvLine}"`);
        console.log(`🔑 API Key行数: ${apiLines.length}`);
        
        // 解析CSV行
        const csvFields = csvLine.split(',').map(f => f.trim());
        if (csvFields.length >= 4) {
          // 收集所有API Keys
          const allApiKeys = [];
          for (const apiLine of apiLines) {
            const tokens = apiLine.split(/\s+/).filter(t => t.length > 0);
            for (const token of tokens) {
              if (/^AIzaSy[A-Za-z0-9_-]{33}$/.test(token)) {
                allApiKeys.push(token);
              }
            }
          }
          
          // 创建账号对象
          const account = {
            email: csvFields[0] || '',
            email_password: csvFields[1] || '',
            two_fa_code: csvFields[2] || '',
            auxiliary_email: csvFields[3] || '',
            account_type: this.guessAccountType(csvFields[0]),
            account_key: allApiKeys.length > 0 ? allApiKeys.join(',') : '',
            storage_date: new Date().toISOString().split('T')[0],
            notes: `解析自CSV+API Key格式 - 原始数据: ${csvLine.substring(0, 50)}...${allApiKeys.length > 0 ? ` (${allApiKeys.length}个API Key)` : ''}`
          };
          
          // 处理空字段
          if (!account.email_password && csvFields.length > 4) {
            account.email_password = csvFields[4] || '';
          }
          
          accounts.push(account);
          console.log(`✅ 解析第${i + 1}组账号: ${account.email} (${allApiKeys.length}个API Key)`);
        }
      }
    }
    
    console.log(`🎉 CSV行+API Key行格式解析完成，共解析 ${accounts.length} 个账号`);
    return accounts;
  }
  
  // 根据邮箱域名猜测账号类型
  guessAccountType(email) {
    if (!email) return '未知';
    
    const domain = email.split('@')[1]?.toLowerCase() || '';
    
    if (domain.includes('gmail')) return 'Gmail';
    if (domain.includes('outlook') || domain.includes('hotmail')) return 'Outlook';
    if (domain.includes('yahoo')) return 'Yahoo';
    if (domain.includes('icloud')) return 'iCloud';
    
    return '其他邮箱';
  }
}

module.exports = SmartDataParser;